// 개발 편의 스위치 — **패스키 부트스트랩 관문 건너뛰기** (2026-08-19 사용자 지시).
//
// 관문의 존재 이유(유심 스와핑범이 공백기에 첫 패스키를 심는 것 방지)는 그대로 옳다.
// 문제는 개발이다: 웹 브라우저로만 보는 동안은 지문·얼굴 장치가 없어 **정당한 운영자도
// 관문을 영영 통과할 수 없다** — 개발 중에는 지킬 계정도, 노릴 공격자도 없는데
// 화면만 잠긴다. 그래서 개발 환경에 한해 스위치로 연다.
//
// **이중 잠금** — 이 스위치가 출시 빌드에 새어 들어가는 길을 두 겹으로 막는다:
//   ① 여기: NODE_ENV가 production이면 값이 있어도 무시한다
//   ② envBootCheck: production에서 이 값이 설정돼 있으면 **부팅 자체를 거부**한다
//      — ①이 언젠가 리팩터링으로 지워져도 서버가 뜨지 않는 쪽으로 실패한다
export function passkeyGateBypassed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEV_SKIP_PASSKEY_GATE === '1' && env.NODE_ENV !== 'production';
}

/** envBootCheck가 부른다 — 운영 모드에 개발 스위치가 남아 있으면 부팅을 막는다 */
export function assertNoDevGatesInProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.DEV_SKIP_PASSKEY_GATE) {
    throw new Error(
      '운영 환경에 개발용 스위치 DEV_SKIP_PASSKEY_GATE가 설정되어 있습니다 — 패스키 관문을 우회하는 값이라 지우기 전에는 서버를 시작하지 않습니다',
    );
  }
}
