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

/**
 * 집계 창.
 *
 * @근거 설계 피로는 지금 상태이지 이력이 아니라 짧게 본다. 더 짧으면(3일) 조용한
 *   주말에 표본이 5건 미만으로 떨어져 유형별 판정이 통째로 침묵하고, 더 길면(30일)
 *   이미 고쳐진 습관이 계속 빨갛게 남는다. **화면 문구도 이 값에서 뽑는다** — 예전에는
 *   서비스와 화면 네 곳에 `7` 이 손으로 적혀 있었다.
 */
export const DECISION_SPEED_WINDOW_DAYS = 7;
/** @근거 설계 위 값의 밀리초 환산 — 고르는 값이 아니라 유도값이다. 손으로 곱한 수를
 *    쓰지 않는 이유는 날짜를 바꿀 때 둘 중 하나만 따라가는 사고를 막기 위해서다 */
export const DECISION_SPEED_WINDOW_MS = DECISION_SPEED_WINDOW_DAYS * 86_400_000;

/**
 * 판단 시간을 실제로 재기 시작한 순간 = `decisionElapsedMs` 가 배포된 날.
 *
 * @근거 설계 이 앞의 승인에는 잴 장치가 자체가 없었다 — "시간이 없다"가 결함이 아니라
 *   **나이**인 구간의 경계다. 관측으로 유도하지 않는 이유: 가장 이른 non-null 판정
 *   시각으로 뽑을 수도 있지만, 그러면 소급 기입·시드 한 건이 경계를 통째로 옮긴다.
 *   배포일은 사실이고 움직이지 않는다.
 */
export const ELAPSED_MEASURE_START = Date.UTC(2026, 7, 22);

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

/** 집계 창 안의 소견 유형별 판단 시간 중앙값 — 관리자 화면 표시용 */
export async function getDecisionSpeedByCategory(prisma: PrismaClient): Promise<DecisionSpeedRow[]> {
  const since = new Date(Date.now() - DECISION_SPEED_WINDOW_MS);
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
  /** 최근 창 안의 승인 판정 수 */
  approvedTotal: number;
  /** 그중 판단 시간이 비어 있는 건 = beforeMeasureStart + offQueue */
  approvedWithoutElapsed: number;
  /**
   * **측정 도입 전에 판정된 건** — 결함이 아니라 나이다. 잴 장치가 없던 때의 기록이라
   * 고칠 것이 없고, 창이 지나가면 저절로 사라진다.
   */
  beforeMeasureStart: number;
  /**
   * **측정이 돌고 있는데도 시간이 없는 건 — 이쪽이 진짜 신호다.**
   * 화면이 시간을 재서 보내는 구조라, 비어 있다는 것은 큐에서 펼친 카드가 아닌
   * 경로로 승인이 들어왔거나 시간이 실려 오지 않았다는 뜻이다.
   */
  offQueue: number;
}

/**
 * 승인 중 판단 시간이 null 인 비율의 재료 (회신 9호 §2).
 * `getDecisionSpeedByCategory` 는 시간이 있는 건만 모으므로 없는 건은 분모에서도 사라진다 —
 * 그 사라진 건을 세는 것이 이 함수다. 승인만 센다: 피로 필터가 걸리는 유일한 판정이라
 * (train:operator 의 제외 조건이 APPROVED & <3초), 시간이 없으면 필터가 눈을 감는 건이다.
 */
export async function getApprovedElapsedCoverage(
  prisma: PrismaClient,
  now = new Date(),
): Promise<ApprovedElapsedCoverage> {
  const since = now.getTime() - DECISION_SPEED_WINDOW_MS;
  /* **사유를 건별로 가른다** (2026-08-24 창업자 지시). 예전에는 빈 건을 하나로 세고,
     이유는 화면이 **집계 창이 측정 시작일을 물고 있는가**로 짐작했다 — 창의 성질이지
     그 건의 성질이 아니라, 창이 걸쳐 있는 동안에는 진짜 큐 밖 승인까지 전부 "측정 전"
     으로 덮였다. 판정 시각은 행마다 있으므로 행에게 직접 물으면 될 일이었다 */
  const [row] = await prisma.$queryRaw<
    { total: bigint | number; before: bigint | number; off: bigint | number }[]
  >`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN "decisionElapsedMs" IS NULL
                     AND "operatorReviewedAt" <  ${ELAPSED_MEASURE_START} THEN 1 ELSE 0 END) AS before,
           SUM(CASE WHEN "decisionElapsedMs" IS NULL
                     AND "operatorReviewedAt" >= ${ELAPSED_MEASURE_START} THEN 1 ELSE 0 END) AS off
    FROM "ComplianceReview"
    WHERE "operatorVerdict" = 'APPROVED' AND "operatorReviewedAt" >= ${since}`;
  const beforeMeasureStart = Number(row?.before ?? 0);
  const offQueue = Number(row?.off ?? 0);
  return {
    approvedTotal: Number(row?.total ?? 0),
    // 합으로 낸다 — 따로 세면 세 숫자가 언젠가 어긋나고, 화면은 그 어긋남을 못 본다
    approvedWithoutElapsed: beforeMeasureStart + offQueue,
    beforeMeasureStart,
    offQueue,
  };
}
