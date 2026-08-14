import { PrismaClient } from '@prisma/client';

// Next.js 개발 모드 핫리로드에서 커넥션이 불어나지 않도록 전역 싱글턴 유지
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient; walSet?: boolean };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

// ── SQLite를 두 프로세스가 함께 쓴다 (2026-08-15) ─────────────────
//
// 웹 서버(Next.js)와 배치 스케줄러(pm2)가 **같은 파일에 각자 붙는다.** 판정 배치는
// 트랜잭션 하나로 판정·정산·에스크로·알림을 한꺼번에 쓰는데, 기본 저널 모드
// (`journal_mode=delete`)에서는 그 쓰기가 **읽기까지 막는다** — 배치가 도는 동안
// 마켓을 둘러보던 사람이 SQLITE_BUSY를 맞는다. 실측으로 이 DB는 `delete` 모드였다.
//
// WAL은 그 성질을 바꾼다: 쓰는 사람이 하나여도 **읽는 사람은 안 막힌다.**
// 쓰기끼리는 여전히 직렬이지만 그건 우리 구조와 이미 맞다 — 판정 큐가 프로세스
// 하나의 순차 큐다. 그리고 `busy_timeout`이 5초라(Prisma 기본, 실측) 겹친 쓰기는
// 오류가 아니라 대기가 된다.
//
// 이것이 Postgres를 대신한다는 뜻은 아니다. 다만 **"DB 락 때문에 런칭 전에 반드시
// 옮겨야 한다"는 진단의 실제 원인은 엔진이 아니라 저널 모드**였고, 그건 한 줄이다.
// journal_mode는 파일에 저장되는 영구 설정이라 한 번만 먹으면 된다.
if (!globalForPrisma.walSet && (process.env.DATABASE_URL ?? '').startsWith('file:')) {
  globalForPrisma.walSet = true;
  // `PRAGMA journal_mode`는 바뀐 모드를 **행으로 돌려주므로** $executeRaw가 거부한다
  // ("Execute returned results, which is not allowed in SQLite") — 조회로 불러야 한다
  void prisma
    .$queryRawUnsafe('PRAGMA journal_mode=WAL')
    .catch((e) => console.error('WAL 전환 실패 — 배치 중 읽기가 막힐 수 있습니다:', e));
}
