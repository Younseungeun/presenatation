import { identityPepper } from './authService';
import { assertNoDevGatesInProduction } from './devGates';
import { assertPayoutEncKeyLoadable } from './fieldCrypto';
import { relyingParty } from './passkeyService';
import { authSecret } from './sessionToken';

// 필수 운영 비밀의 부팅 시점 검사 (2026-08-18 배선 점검 1차 채택).
//
// 각 비밀은 이미 **호출 시점**에 스스로를 지킨다 (운영 + 값 없음 = 던짐). 그것만으로는
// 서버가 일단 떠서 **첫 손님에서** 죽는다 — 배포 파이프라인 관점에서는 트래픽을 받기
// 전에 죽는 쪽(fast fail)이 롤백과 장애 인지에 훨씬 유리하다. 그래서 두 겹이다:
// instrumentation.ts가 기동 때 여기를 한 번 부르고, 호출 시점 검사는 그대로 남는다
// (이 목록이 낡아도 마지막 방어선은 산다).
//
// ── 검사 내용을 여기 옮겨 적지 않는다 ─────────────────────────────
// 이 함수는 **실제 게터를 그대로 부른다.** 검사 규칙(형식·폴백·언제 던지나)의 진실은
// 게터 하나뿐이라, 부팅 검사와 런타임이 다른 답을 낼 수 없다. 남는 어긋남은 하나 —
// **목록 누락**(새 비밀의 게터를 만들고 여기 안 부르는 것)이다. 새 비밀을 만들면
// 게터에 "운영이면 던진다"를 넣고, 여기 한 줄을 추가하라 — 에러 메시지를
// "운영 환경에는 X가 반드시 있어야 합니다" 규약대로 적으면 envGuards.test.ts의
// 소스 스캔 래칫이 목록 추가를 **강제한다** (빠뜨리면 시험이 깨진다).

/**
 * 필수 운영 비밀 넷을 한 자리에서 검사한다. 운영 모드에서 하나라도 없으면 던진다.
 *
 * **전부 검사하고 한 번에 보고한다** — 첫 실패에서 멈추면 출시 날 "고치고 재부팅"을
 * 빠진 개수만큼 반복하게 된다.
 */
export function assertProductionSecrets(env = process.env): void {
  const failures: string[] = [];
  const checks: Array<() => unknown> = [
    () => authSecret(env), //         세션·복구 인가 서명
    () => identityPepper(env), //     신원(CI) 해시
    () => assertPayoutEncKeyLoadable(env), // 계좌번호 암호화 키
    () => relyingParty(env), //       패스키 origin (NEXT_PUBLIC_APP_ORIGIN)
  ];
  for (const check of checks) {
    try {
      check();
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `필수 운영 환경 변수가 빠져 있어 서버를 시작하지 않습니다 (${failures.length}건):\n` +
        failures.map((m) => `  - ${m}`).join('\n'),
    );
  }
  // 값이 **없어야** 통과하는 검사 — 개발용 우회 스위치가 운영에 남아 있으면 부팅 거부.
  // 위 목록과 방향이 반대라 게터 패턴에 안 실리고 여기서 직접 부른다
  assertNoDevGatesInProduction(env);
}
