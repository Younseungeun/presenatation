import type { PrismaClient } from '@prisma/client';

// **운영자 판단 소요 시간** (26차 CC-1 반증 조건 — 피로도 함정 감지).
//
// 라이브 r5 유지의 대가는 오탐 흡수인데, 오탐과 정상 승인이 화면에서 같은 '승인'
// 클릭이라 결과 데이터로는 구별되지 않는다 (검토자 gap 17형). 유일한 감별 신호가
// **열람→판정까지의 시간**이다: 특정 유형(SCREENING_EVASION·CARD_MISMATCH)의 판단이
// 다른 유형의 절반 밑으로 떨어지면, 운영자는 그 소견을 읽지 않고 승인하고 있다.
//
// 시간은 관리자 화면이 재서 보낸다(서버는 열람 시각을 모른다). 텔레메트리라 판정
// 트랜잭션에 합류하지 않는다 — 기록이 실패해도 판정은 성립해야 한다.

/** @근거 설계 — 하루를 넘는 값은 측정이 아니라 방치다 (탭을 열어 둔 채 퇴근) */
const MAX_ELAPSED_MS = 86_400_000;

/**
 * 방금 내린 판정 건들에 소요 시간을 붙인다.
 * 최근 5분 내 판정 + 아직 비어 있는 칸만 — 과거 판정에 소급 기입되면 안 된다.
 */
export async function recordDecisionElapsed(
  prisma: PrismaClient,
  reportId: string,
  elapsedMs: number,
): Promise<void> {
  const ms = Math.min(Math.max(1, Math.round(elapsedMs)), MAX_ELAPSED_MS);
  const cutoff = new Date(Date.now() - 5 * 60_000).getTime();
  // 새 칸이라 클라이언트 타입 재생성 전에도 동작해야 한다 — raw 로 쓴다
  await prisma.$executeRaw`
    UPDATE "ComplianceReview" SET "decisionElapsedMs" = ${ms}
    WHERE "reportId" = ${reportId}
      AND "operatorReviewedAt" IS NOT NULL
      AND "operatorReviewedAt" >= ${cutoff}
      AND "decisionElapsedMs" IS NULL`;
}

export interface DecisionSpeedRow {
  category: string;
  n: number;
  medianMs: number;
  /** 전 유형 중앙값의 절반 미만 — 검토자 반증 조건("2배 이상 짧다") 발동 */
  fatigueSuspect: boolean;
}

/** 최근 7일, 소견 유형별 판단 시간 중앙값 — 관리자 화면 표시용 */
export async function getDecisionSpeedByCategory(prisma: PrismaClient): Promise<DecisionSpeedRow[]> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const rows = await prisma.complianceReview.findMany({
    where: { operatorReviewedAt: { gte: since }, NOT: { operatorVerdict: null } },
    select: { findingsJson: true, operatorReviewedAt: true, id: true },
  });
  // decisionElapsedMs 는 새 칸이라 select 타입에 없을 수 있다 — raw 로 병행 조회
  const elapsed = await prisma.$queryRaw<{ id: string; decisionElapsedMs: number | null }[]>`
    SELECT "id", "decisionElapsedMs" FROM "ComplianceReview"
    WHERE "operatorReviewedAt" >= ${since.getTime()} AND "decisionElapsedMs" IS NOT NULL`;
  const byId = new Map(elapsed.map((e) => [e.id, e.decisionElapsedMs]));

  const perCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const r of rows) {
    const ms = byId.get(r.id);
    if (ms == null) continue;
    all.push(ms);
    let cats: string[] = [];
    try {
      cats = [
        ...new Set(
          (JSON.parse(r.findingsJson) as { category?: string }[]).map((f) => f.category ?? ''),
        ),
      ].filter(Boolean);
    } catch {
      /* 손상된 행은 셈에서 뺀다 */
    }
    for (const c of cats) {
      const slot = perCategory.get(c) ?? [];
      slot.push(ms);
      perCategory.set(c, slot);
    }
  }
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)]! : 0;
  };
  const overall = median(all);
  return [...perCategory.entries()]
    .map(([category, xs]) => ({
      category,
      n: xs.length,
      medianMs: median(xs),
      // 표본 5건 미만이면 판정하지 않는다 — 한두 건의 빠른 클릭은 피로가 아니라 우연이다
      fatigueSuspect: xs.length >= 5 && overall > 0 && median(xs) < overall / 2,
    }))
    .sort((a, b) => a.medianMs - b.medianMs);
}

export interface ApprovedElapsedCoverage {
  /** 최근 7일 승인 판정 수 */
  approvedTotal: number;
  /** 그중 판단 시간이 비어 있는 건 — 0 이 아니면 큐 밖 경로로 승인되는 건이 있다 */
  approvedWithoutElapsed: number;
}

/**
 * 승인 중 판단 시간이 null 인 비율의 재료 (회신 9호 §2).
 * `getDecisionSpeedByCategory` 는 시간이 있는 건만 모으므로 없는 건은 분모에서도 사라진다 —
 * 그 사라진 건을 세는 것이 이 함수다. 승인만 센다: 피로 필터가 걸리는 유일한 판정이라
 * (train:operator 의 제외 조건이 APPROVED & <3초), 시간이 없으면 필터가 눈을 감는 건이다.
 */
export async function getApprovedElapsedCoverage(
  prisma: PrismaClient,
): Promise<ApprovedElapsedCoverage> {
  const since = new Date(Date.now() - 7 * 86_400_000).getTime();
  const [row] = await prisma.$queryRaw<{ total: bigint | number; missing: bigint | number }[]>`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN "decisionElapsedMs" IS NULL THEN 1 ELSE 0 END) AS missing
    FROM "ComplianceReview"
    WHERE "operatorVerdict" = 'APPROVED' AND "operatorReviewedAt" >= ${since}`;
  return {
    approvedTotal: Number(row?.total ?? 0),
    approvedWithoutElapsed: Number(row?.missing ?? 0),
  };
}
