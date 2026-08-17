import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

// 필드 단위 가역 암호화 — **계좌번호 전용으로 만들었다.**
//
// ── 왜 해시가 아닌가 ────────────────────────────────────────────
// 이 저장소가 비밀을 다루는 방식은 원래 **단방향**이다(CI는 HMAC 해시로만 남기고
// 원문을 안 쓴다). 계좌번호는 그럴 수 없다 — **은행에 그 값을 그대로 보내야** 이체가
// 된다. 그래서 되돌릴 수 있는 암호화가 필요하고, 그 순간부터 키 관리가 시스템의 일부가 된다.
//
// ── 무엇을 지키나 ───────────────────────────────────────────────
// DB 파일이나 백업이 통째로 새어 나갔을 때 **계좌번호 목록이 되지 않게** 하는 것이
// 전부다. 애플리케이션이 털리면 키도 함께 털리므로 그 경우는 못 막는다 —
// 지킬 수 있는 범위를 정확히 적어 두는 것이 지킨다고 말하는 것보다 낫다.
//
// ── AES-256-GCM인 이유 ──────────────────────────────────────────
// 인증 태그가 붙어 **조작을 탐지한다.** CBC였다면 누가 암호문을 바꿔치기해도 복호화가
// 그럴듯한 쓰레기를 내놓고, 그 값이 그대로 은행으로 갈 수 있다. 돈이 나가는 경로에서는
// "틀린 값을 조용히 돌려주는" 실패가 가장 나쁘다.

/** `PAYOUT_ENC_KEY` — 32바이트 hex(64자). 없으면 개발용 키로 물러선다 */
function encryptionKey(env = process.env): Buffer {
  const raw = env.PAYOUT_ENC_KEY;
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  if (raw) {
    // 형식이 틀린 키는 **조용히 무시하지 않는다** — 개발 키로 물러서면 운영에서
    // 암호화된 것처럼 보이면서 실제로는 공개된 키를 쓰게 된다
    throw new Error('PAYOUT_ENC_KEY는 32바이트 hex(64자)여야 합니다');
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('운영 환경에는 PAYOUT_ENC_KEY가 반드시 있어야 합니다');
  }
  // 개발·테스트 전용. 고정값이라 재시작해도 같은 값을 복호화할 수 있다
  return createHash('sha256').update('dev-payout-enc-key').digest();
}

/**
 * 부팅 검사용 — 키를 **돌려주지 않고** 로드 가능한지만 확인한다.
 * 검사 내용은 encryptionKey 그 자체다 — 규칙을 옮겨 적으면 언젠가 둘이 갈라진다.
 */
export function assertPayoutEncKeyLoadable(env = process.env): void {
  encryptionKey(env);
}

/** `iv:tag:ciphertext` (전부 base64) — 한 문자열로 묶어 컬럼 하나에 넣는다 */
export function encryptField(plain: string, env = process.env): string {
  const iv = randomBytes(12); // GCM 권장 길이
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(
    ':',
  );
}

/** 조작됐거나 다른 키로 암호화된 값이면 **던진다** (그럴듯한 쓰레기를 돌려주지 않는다) */
export function decryptField(stored: string, env = process.env): string {
  const parts = stored.split(':');
  if (parts.length !== 3) throw new Error('암호문 형식이 올바르지 않습니다');
  const [iv, tag, data] = parts;
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

/**
 * 화면·감사에 쓰는 뒤 4자리.
 *
 * 이 값이 있어야 **"어느 계좌인가"를 묻는 데 복호화가 필요 없어진다.** 운영 화면이
 * 계좌를 확인하려고 매번 원문을 꺼내면, 원문이 로그·에러 리포트·메모리 덤프로
 * 새어 나가는 경로가 그만큼 늘어난다.
 */
export function last4(accountNumber: string): string {
  const digits = accountNumber.replace(/\D/g, '');
  return digits.slice(-4).padStart(4, '*');
}
