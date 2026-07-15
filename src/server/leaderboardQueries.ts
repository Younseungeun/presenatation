import type { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, Outcome } from '@/domain/constants';
import { computeTrackRecord, type JudgedPrediction } from '@/domain/trackRecord';
import { seasonStart, nextSeasonStart } from './scoreService';

// 리더보드·공개 프로필용 집계 (읽기 전용).
// 리더보드는 자산군별로 분리 (§2.2 확정) — assetClass로 필터한다.

interface JudgmentRow {
  score: number | null;
  outcome: string;
  settledPrice: number | null;
  judgedAt: Date;
  predictionCard: {
    assetClass: string;
    direction: string;
    basePrice: number | null;
  };
}

function toJudgedPrediction(j: JudgmentRow): JudgedPrediction {
  return {
    outcome: j.outcome as Outcome,
    direction: j.predictionCard.direction as Direction,
    basePrice: j.predictionCard.basePrice ?? 0,
    settledPrice: j.settledPrice ?? undefined,
    judgedAt: j.judgedAt,
  };
}

const JUDGMENT_SELECT = {
  score: true,
  outcome: true,
  settledPrice: true,
  judgedAt: true,
  predictionCard: {
    select: { assetClass: true, direction: true, basePrice: true },
  },
} as const;

export interface LeaderboardEntry {
  researcherId: string;
  name: string;
  tier: string;
  careerBadge: string | null;
  seasonScore: number;
  hitRate: number | null;
  sampleSize: number;
  verifying: boolean;
  hypotheticalReturnPct: number | null;
}

/** 자산군별 리더보드 — 현재 시즌 점수 기준 내림차순 */
export async function getLeaderboard(
  prisma: PrismaClient,
  assetClass: AssetClass,
  now = new Date(),
): Promise<LeaderboardEntry[]> {
  const profiles = await prisma.researcherProfile.findMany({
    include: {
      user: { select: { penName: true, email: true } },
      reports: {
        select: {
          predictionCard: {
            select: { assetClass: true, judgment: { select: JUDGMENT_SELECT } },
          },
        },
      },
    },
  });

  const seasonLo = seasonStart(now);
  const seasonHi = nextSeasonStart(now);

  const entries = profiles.map((p) => {
    const judgments = p.reports
      .map((r) => r.predictionCard?.judgment)
      .filter((j): j is NonNullable<typeof j> => !!j && j.predictionCard.assetClass === assetClass);

    const seasonScore = judgments
      .filter((j) => j.judgedAt >= seasonLo && j.judgedAt < seasonHi)
      .reduce((acc, j) => acc + (j.score ?? 0), 0);

    const record = computeTrackRecord(judgments.map(toJudgedPrediction), now);
    return {
      researcherId: p.id,
      name: p.user.penName ?? p.user.email,
      tier: p.tier,
      careerBadge: p.careerBadge,
      seasonScore,
      hitRate: record.hitRate,
      sampleSize: record.sampleSize,
      verifying: record.verifying,
      hypotheticalReturnPct: record.hypotheticalReturnPct,
    };
  });

  // 판정 표본이 있는 리서처만 노출, 시즌 점수 내림차순
  return entries
    .filter((e) => e.sampleSize > 0)
    .sort((a, b) => b.seasonScore - a.seasonScore);
}

/** 공개 프로필: 자산군별 트랙레코드 + 판매 중 리포트 + 판정 이력 */
export async function getPublicProfile(
  prisma: PrismaClient,
  researcherId: string,
  now = new Date(),
) {
  const profile = await prisma.researcherProfile.findUnique({
    where: { id: researcherId },
    include: {
      user: { select: { penName: true, email: true } },
      reports: {
        orderBy: { publishedAt: 'desc' },
        include: { predictionCard: { include: { judgment: true } } },
      },
    },
  });
  if (!profile) return null;

  const judgedCards = profile.reports
    .map((r) => r.predictionCard)
    .filter((c) => c?.judgment) as Array<
    NonNullable<(typeof profile.reports)[number]['predictionCard']>
  >;

  // 자산군별 트랙레코드
  const byAsset = new Map<AssetClass, JudgedPrediction[]>();
  for (const c of judgedCards) {
    const list = byAsset.get(c.assetClass as AssetClass) ?? [];
    list.push({
      outcome: c.judgment!.outcome as Outcome,
      direction: c.direction as Direction,
      basePrice: c.basePrice ?? 0,
      settledPrice: c.judgment!.settledPrice ?? undefined,
      judgedAt: c.judgment!.judgedAt,
    });
    byAsset.set(c.assetClass as AssetClass, list);
  }
  const trackRecords = [...byAsset.entries()].map(([assetClass, preds]) => ({
    assetClass,
    ...computeTrackRecord(preds, now),
  }));

  const buyable = profile.reports.filter((r) => r.status === 'PUBLISHED');
  const history = profile.reports.filter((r) => r.predictionCard?.judgment);

  return { profile, trackRecords, buyable, history };
}

/** 리포트 상세 + 뷰어의 구매 여부 */
export async function getReportDetail(
  prisma: PrismaClient,
  reportId: string,
  viewerUserId: string | null,
) {
  const report = await prisma.report.findUnique({
    where: { id: reportId },
    include: {
      predictionCard: { include: { judgment: true } },
      researcher: { include: { user: { select: { penName: true, email: true } } } },
    },
  });
  if (!report) return null;

  const purchase = viewerUserId
    ? await prisma.purchase.findUnique({
        where: { reportId_buyerId: { reportId, buyerId: viewerUserId } },
        include: { settlement: true },
      })
    : null;

  return { report, purchase };
}
