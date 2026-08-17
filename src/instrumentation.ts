// 서버 기동 시 1회 실행 (Next instrumentation 규약 — register는 요청을 받기 전에
// 완료돼야 한다). 필수 운영 비밀이 빠졌으면 **여기서 죽는다**: 첫 손님이 에러를
// 맞는 것보다 트래픽을 받기 전에 죽는 쪽이 롤백과 장애 인지에 유리하다.
// 검사 규칙 자체는 각 게터에 산다 — src/server/envBootCheck.ts 참고.

export async function register() {
  // 검사 대상이 전부 Node 전용(node:crypto)이다 — edge 기동에서는 부르지 않는다
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // `next build`는 NODE_ENV=production인데 런타임 비밀 없이 돌아야 한다 —
  // 빌드 중 프리렌더 워커의 기동은 건너뛴다 (호출 시점 검사는 그대로 남아 있다)
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { assertProductionSecrets } = await import('./server/envBootCheck');
  try {
    assertProductionSecrets();
  } catch (e) {
    // 던지기만 하면 Next가 에러를 삼키고 **포트를 연 채 전부 500을 뱉는다** (실측
    // 2026-08-18) — 요청은 안 처리되지만 pm2·헬스체크가 "죽었다"를 감지하지 못하는
    // 반쪽 fast-fail이다. 프로세스를 확실히 끝내야 재시작·롤백이 즉시 일어난다.
    console.error(e);
    process.exit(1);
  }
}
