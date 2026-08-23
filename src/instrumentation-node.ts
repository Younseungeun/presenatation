// Node 런타임 전용 기동 검사 — instrumentation.ts 가 nodejs 분기에서만 동적으로 가져온다.
//
// 왜 파일을 나눴나 (회신 11호 §2): Next 는 instrumentation.ts 를 edge 용으로도 컴파일한다.
// 그 파일 본문에 process.exit 가 있으면 런타임 가드가 서 있어도 번들러가 정적으로 보고
// "A Node.js API is used … not supported in the Edge Runtime" 을 기동마다 찍는다. Next 문서의
// 처방대로 런타임별 코드를 별 파일로 빼서 조건부 import 한다 — edge 번들은 이 파일을 모른다.
//
// 필수 운영 비밀이 빠졌거나 검수가 쓰는 표가 없으면 **여기서 죽는다**: 첫 손님이 에러를
// 맞는 것보다 트래픽을 받기 전에 죽는 쪽이 롤백과 장애 인지에 유리하다.

export async function registerNode(): Promise<void> {
  const { assertProductionSecrets } = await import('./server/envBootCheck');
  const { assertSchemaPresent } = await import('./server/schemaBootCheck');
  const { prisma } = await import('./server/db');
  try {
    assertProductionSecrets();
    // 스키마 실재 — 마이그레이션 기록이 "적용됨"이어도 표가 없을 수 있다 (회신 9호 §1).
    // 검수가 쓰는 표가 없으면 화면이 아니라 부팅이 실패해야 한다
    await assertSchemaPresent(prisma);
  } catch (e) {
    // 던지기만 하면 Next가 에러를 삼키고 **포트를 연 채 전부 500을 뱉는다** (실측
    // 2026-08-18) — 요청은 안 처리되지만 pm2·헬스체크가 "죽었다"를 감지하지 못하는
    // 반쪽 fast-fail이다. 프로세스를 확실히 끝내야 재시작·롤백이 즉시 일어난다.
    console.error(e);
    process.exit(1);
  }
}
