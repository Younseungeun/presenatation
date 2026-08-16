import type { PrismaClient } from '@prisma/client';
import type { SessionClaims } from './sessionToken';

// **경로의 차이를 권한의 차이로 바꾼다** (2026-08-16, 인증 축 검토 A·B).
//
// ── 왜 필요한가 ───────────────────────────────────────────────
// 로그인하는 길이 둘이 되는 순간(본인 인증 / 패스키) **도둑은 쉬운 쪽을 고른다.**
// 유심을 가로챈 공격자는 패스키가 있든 없든 본인 인증으로 그냥 들어온다. 그래서
// 패스키를 붙였다고 계정 진입의 강도가 오른 것이 아니다 — 오른 것은 편의다.
//
// 강도를 실제로 올리려면 "패스키가 있는 계정은 본인 인증으로 못 들어온다"로 가야 하는데,
// 그러면 기기를 잃은 사람이 영영 못 들어온다. 그래서 **들어오게는 하되, 돈과 열쇠에
// 닿는 것만 유예한다.**
//
// ── 두 관문 ───────────────────────────────────────────────────
//   ① 최근성   패스키를 심으려면 **방금** 본인 인증을 통과했어야 한다
//   ② 경로     패스키가 있는 계정에 **본인 인증으로** 들어온 세션은 열쇠를 못 심는다
//
// ── 무엇을 막고 무엇은 안 막는지 정확히 ─────────────────────────
// 둘 다 막는 것은 **열쇠를 심는 것**이지 돈이 아니다. 돈은 따로 막혀 있다 —
// 계좌 변경은 본인 인증 재확인과 은행 예금주 대조를 통과해야 하고, 그 뒤에도 48시간
// 쿨다운이 있다. 이 파일이 없어도 **돈은 안 나갔다.**
//
// 그래서 ①과 ②의 무게가 다르다:
//   ② 유심 스와핑 — 실제로 일어나고, 본인 인증 하나로 계정에 들어온다. **넓다**
//   ① 세션 유출   — 악성코드나 물리적 접근이 선행돼야 한다. **좁다**
// ①을 넣는 이유는 급해서가 아니라 값이 싸기 때문이다: 감염된 PC에서 한 번 세션이 새면
// 악성코드를 지운 뒤에도 심어 둔 열쇠는 남는다.

export class AuthGateError extends Error {
  constructor(
    message: string,
    /** 클라이언트가 분기할 수 있게 — 재인증으로 풀리는지, 기다려야 풀리는지 */
    readonly code: 'REVERIFY_REQUIRED' | 'ELEVATED_RISK_HOLD',
  ) {
    super(message);
    this.name = 'AuthGateError';
  }
}

/**
 * 본인 인증이 이만큼 지났으면 다시 받는다.
 *
 * 짧게 잡는 이유: 이 창은 "지금 화면 앞에 있는 사람이 방금 인증한 그 사람"이라고
 * 믿는 시간이다. 길게 두면 그만큼 **새어 나간 세션이 걸어 들어올 창**이 된다.
 * 10분은 인증을 마치고 다음 화면으로 넘어가 등록을 끝내기에 넉넉하다.
 *
 * @근거 설계 인증 직후 등록을 마치기에 넉넉하되, 훔친 세션이 걸어 들어올 창은 좁게
 */
export const STEP_UP_WINDOW_MS = 10 * 60_000;

/**
 * 위험한 경로로 들어온 세션이 열쇠를 심지 못하는 기간.
 *
 * 계좌 변경 쿨다운과 같은 48시간이다 — 근거가 같기 때문이다. 둘 다 "본인이 알아채고
 * 멈출 수 있는 시간"이고, 그 길이는 사람이 알림을 보고 반응하는 시간에서 나온다.
 *
 * @근거 설계 계좌 변경 쿨다운과 같은 근거 — 본인이 알아채고 멈출 수 있는 시간
 */
export const ELEVATED_RISK_HOLD_MS = 48 * 3_600_000;

/**
 * **① 최근성 요구** — 패스키 등록은 방금 본인 인증한 세션만 할 수 있다.
 *
 * 첫 등록도 예외로 두지 않는다. "가입하고 한 달 뒤 처음 등록하는 사람"의 세션이 이미
 * 탈취돼 있을 수 있고, **보안 규칙의 예외는 반드시 그 자리가 공격 경로가 된다.**
 * 가입 직후 등록은 방금 인증했으므로 자연히 통과한다 — 예외를 안 두고도 매끄럽다.
 */
export function assertRecentlyVerified(claims: SessionClaims, now = new Date()): void {
  if (now.getTime() - claims.verifiedAt <= STEP_UP_WINDOW_MS) return;
  throw new AuthGateError(
    '보안을 위해 본인 인증을 다시 한 번 해주세요 — 기기 등록은 인증 직후에만 할 수 있습니다.',
    'REVERIFY_REQUIRED',
  );
}

/**
 * **② 경로별 권한** — 패스키가 있는 계정에 본인 인증으로 들어왔으면 유예한다.
 *
 * 패스키가 **하나도 없는** 계정은 걸지 않는다. 그때는 본인 인증이 유일한 길이라
 * 비대칭 자체가 없고, 걸어 버리면 **아무도 첫 기기를 등록하지 못한다.**
 *
 * 삭제는 막지 않는다 — 그쪽은 권한을 **내려놓는** 행위다. 기기를 잃어버린 사람이
 * 그 기기를 지우려는 것을 막으면, 도둑이 쥔 열쇠를 주인이 못 뽑게 된다.
 */
export async function assertNotElevatedRisk(
  prisma: PrismaClient,
  claims: SessionClaims,
  now = new Date(),
): Promise<void> {
  if (claims.method !== 'IDENTITY') return;

  const passkeys = await prisma.passkey.count({ where: { userId: claims.userId } });
  if (passkeys === 0) return;

  const since = now.getTime() - claims.verifiedAt;
  if (since >= ELEVATED_RISK_HOLD_MS) return;

  const hours = Math.ceil((ELEVATED_RISK_HOLD_MS - since) / 3_600_000);
  throw new AuthGateError(
    `이미 등록된 기기가 있는 계정에 다른 경로로 로그인하셨습니다 — ` +
      `보안을 위해 ${hours}시간 뒤부터 새 기기를 등록할 수 있습니다.\n` +
      `본인이 로그인한 것이 아니라면 지금 바로 정산을 동결해주세요.`,
    'ELEVATED_RISK_HOLD',
  );
}

/**
 * 위험한 경로의 로그인을 **본인에게 알린다.**
 *
 * 유예만으로는 절반이다. 48시간이 값어치를 가지려면 그 사이에 본인이 알아채야 하고,
 * 알아채는 유일한 경로가 이 알림이다.
 *
 * ⚠ 지금은 인앱뿐이라 **탈취자도 같이 본다.** 문자가 붙어야 완성된다.
 */
export async function notifyElevatedRiskLogin(
  prisma: PrismaClient,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const passkeys = await prisma.passkey.count({ where: { userId } });
  if (passkeys === 0) return false;

  await prisma.notification.create({
    data: {
      userId,
      type: 'RISKY_LOGIN',
      title: '[중요] 등록된 기기가 아닌 경로로 로그인되었습니다',
      body:
        '휴대폰 본인 인증으로 로그인되었습니다. 평소 쓰시는 지문·얼굴 로그인이 아닙니다.\n' +
        '본인이 새 기기에서 로그인하신 것이라면 그대로 두셔도 됩니다.\n' +
        '**본인이 아니라면 지금 바로 정산을 동결해주세요.** 동결하면 한 푼도 나가지 않습니다.',
      link: '/settings/payout',
      createdAt: now,
    },
  });
  return true;
}
