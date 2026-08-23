// 서버 기동 시 1회 실행 (Next instrumentation 규약 — register는 요청을 받기 전에
// 완료돼야 한다). 실제 검사는 src/instrumentation-node.ts 에 있다 — 이 파일은 edge 용으로도
// 컴파일되므로 Node 전용 API(process.exit 등)를 본문에 두지 않는다 (회신 11호 §2).
// 검사 규칙 자체는 각 게터에 산다 — src/server/envBootCheck.ts · schemaBootCheck.ts 참고.

export async function register() {
  // 검사 대상이 전부 Node 전용(node:crypto·prisma)이다 — edge 기동에서는 부르지 않는다
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // `next build`는 NODE_ENV=production인데 런타임 비밀 없이 돌아야 한다 —
  // 빌드 중 프리렌더 워커의 기동은 건너뛴다 (호출 시점 검사는 그대로 남아 있다)
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const { registerNode } = await import('./instrumentation-node');
  await registerNode();
}
