import type { PrismaClient } from '@prisma/client';

// 스키마 실재 검사 — 기동 시 1회 (회신 9호 §1 · 2026-08-22).
//
// 무엇이 터졌나: `LearnedPhraseHit` 마이그레이션이 `_prisma_migrations` 에는 "적용됨"으로
// 적혀 있는데 표는 없었다. `prisma migrate deploy` 는 "적용할 것 없음"이라 답했고,
// 운영자가 사전 탭을 열어서야 500 으로 드러났다 — 한 함수의 실패가 화면 한 장을 통째로
// 가져갔다. 기록과 실체가 어긋난 날, 기록을 보는 도구는 전부 "정상"이라 말한다.
//
// 왜 Prisma 가 못 잡나: 클라이언트 타입이 재생성되지 않은 칸·표는 **raw SQL 로만**
// 닿는다. Prisma 는 raw 문자열 안의 표 이름을 모르고, 첫 쿼리가 날아갈 때까지 아무
// 검사도 없다. 그래서 여기서 직접 `PRAGMA table_info` 로 묻는다.
//
// 무엇을 검사하나: **raw SQL 이 닿는 표와 칸** 만. ORM 경로의 표는 Prisma 가 첫 쿼리에서
// 자기 에러를 내지만 그것도 "첫 손님에서 죽는" 모양이라, 목록이 커져도 손해는 없다.
// 다만 이 목록의 진실은 **소스**에 있다 — `schemaBootCheck.test.ts` 의 소스 스캔 래칫이
// FROM·INTO·UPDATE 뒤의 따옴표 표 이름이 여기 빠지면 시험을 깨뜨린다
// (envBootCheck 의 목록 누락 방어와 같은 수법).
//
// 모든 모드에서 돈다 (개발 포함). 이 사고는 개발 DB 에서 났다 — 운영에서만 검사하면
// 같은 자리를 또 놓친다.

export interface RequiredSchema {
  table: string;
  /** raw SQL 이 읽거나 쓰는 칸 — 표는 있는데 칸이 없는 경우(클라이언트 미재생성 칸)를 잡는다 */
  columns: string[];
}

/** raw SQL 이 닿는 표·칸. 새 raw 쿼리를 쓰면 여기 한 줄 — 래칫이 강제한다 */
export const REQUIRED_SCHEMA: readonly RequiredSchema[] = [
  { table: 'ComplianceReview', columns: ['decisionElapsedMs', 'operatorReviewedAt', 'operatorVerdict'] },
  {
    table: 'LearnedPhraseHit',
    columns: [
      'phraseId',
      'reportId',
      'researcherId',
      'createdAt',
      // 매칭 스냅샷 (회신 20호 요청 1) — raw INSERT 가 이 칸들에 박는다
      'matchedSentence',
      'matchedSurface',
      'negation',
    ],
  },
];

/**
 * 표·칸이 전부 실재하는지 확인한다. 없으면 **전부 모아** 한 번에 던진다 —
 * 첫 실패에서 멈추면 "고치고 재부팅"을 빠진 개수만큼 반복한다.
 */
export async function assertSchemaPresent(
  prisma: PrismaClient,
  required: readonly RequiredSchema[] = REQUIRED_SCHEMA,
): Promise<void> {
  const failures: string[] = [];
  for (const { table, columns } of required) {
    // 표 이름은 우리 상수라 보간해도 되지만, 혹시 모를 따옴표는 막는다
    const info = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `PRAGMA table_info("${table.replace(/"/g, '')}")`,
    );
    if (info.length === 0) {
      failures.push(`표 "${table}" 이 없습니다 — 마이그레이션 기록만 있고 SQL 이 돌지 않았을 수 있습니다`);
      continue;
    }
    const present = new Set(info.map((c) => c.name));
    for (const col of columns) {
      if (!present.has(col)) failures.push(`표 "${table}" 에 칸 "${col}" 이 없습니다`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `검수가 쓰는 표·칸이 DB 에 없어 서버를 시작하지 않습니다 (${failures.length}건). ` +
        `\`prisma migrate status\` 가 "적용됨"이라 해도 믿지 마십시오 — 기록과 실체가 어긋난 상태입니다:\n` +
        failures.map((m) => `  - ${m}`).join('\n'),
    );
  }
}
