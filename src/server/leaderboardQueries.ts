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

/** 판정 이력이 있는 종목 목록 — 종목별 리더보드 필터용 (판정 많은 순) */
export async function getJudgedInstruments(
  prisma: PrismaClient,
  assetClass: AssetClass,
): Promise<{ ticker: string; assetName: string; judgedCount: number }[]> {
  const cards = await prisma.predictionCard.findMany({
    where: { assetClass, judgment: { isNot: null } },
    select: { ticker: true, assetName: true },
  });

  const byTicker = new Map<string, { ticker: string; assetName: string; judgedCount: number }>();
  for (const c of cards) {
    const row = byTicker.get(c.ticker);
    if (row) row.judgedCount++;
    else byTicker.set(c.ticker, { ticker: c.ticker, assetName: c.assetName, judgedCount: 1 });
  }

  return [...byTicker.values()].sort(
    (a, b) => b.judgedCount - a.judgedCount || a.assetName.localeCompare(b.assetName, 'ko'),
  );
}

/**
 * 자산군별 리더보드 — 현재 시즌 점수 기준 내림차순.
 * ticker를 주면 그 종목의 판정만으로 집계한다(종목별 리더보드).
 */
export async function getLeaderboard(
  prisma: PrismaClient,
  assetClass: AssetClass,
  now = new Date(),
  ticker?: string,
): Promise<LeaderboardEntry[]> {
  // 판정에서 출발해 해당 자산군(·종목)만 조회 — 전체 리서처×리포트 풀스캔 회피
  const judgments = await prisma.judgment.findMany({
    where: { predictionCard: ticker ? { assetClass, ticker } : { assetClass } },
    select: {
      score: true,
      outcome: true,
      settledPrice: true,
      judgedAt: true,
      predictionCard: {
        select: {
          assetClass: true,
          direction: true,
          basePrice: true,
          report: { select: { researcherId: true } },
        },
      },
    },
  });
  if (judgments.length === 0) return [];

  const byResearcher = new Map<string, typeof judgments>();
  for (const j of judgments) {
    const rid = j.predictionCard.report.researcherId;
    const list = byResearcher.get(rid);
    if (list) list.push(j);
    else byResearcher.set(rid, [j]);
  }

  const profiles = await prisma.researcherProfile.findMany({
    where: { id: { in: [...byResearcher.keys()] } },
    include: { user: { select: { penName: true, email: true } } },
  });

  const seasonLo = seasonStart(now);
  const seasonHi = nextSeasonStart(now);

  const entries = profiles.map((p) => {
    const js = byResearcher.get(p.id) ?? [];
    const seasonScore = js
      .filter((j) => j.judgedAt >= seasonLo && j.judgedAt < seasonHi)
      .reduce((acc, j) => acc + (j.score ?? 0), 0);

    const record = computeTrackRecord(js.map(toJudgedPrediction), now);
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

export interface RankingEntry {
  researcherId: string;
  name: string;
  tier: string;
  careerBadge: string | null;
  /** 전체 기간·전 자산군 누적 점수 (리더보드의 시즌 점수와 다르다) */
  totalScore: number;
  hitRate: number | null;
  sampleSize: number;
  verifying: boolean;
  hypotheticalReturnPct: number | null;
}

export type RankingSort = 'SCORE' | 'HIT_RATE' | 'RETURN';

function sortRanking(entries: RankingEntry[], sort: RankingSort): RankingEntry[] {
  const num = (v: number | null) => (v === null ? -Infinity : v);
  return [...entries].sort((a, b) => {
    // 점수 외 기준에서는 표본 미달(검증 중)을 뒤로 보낸다 —
    // 1건 100% 적중이 상위를 차지하는 왜곡 방지 (§2.2 표본 수 표시 원칙)
    if (sort !== 'SCORE' && a.verifying !== b.verifying) return a.verifying ? 1 : -1;
    if (sort === 'HIT_RATE') return num(b.hitRate) - num(a.hitRate);
    if (sort === 'RETURN') return num(b.hypotheticalReturnPct) - num(a.hypotheticalReturnPct);
    return b.totalScore - a.totalScore;
  });
}

/**
 * 전체 랭킹 — 전 기간·전 자산군 통합.
 * 리더보드(getLeaderboard)가 "이번 시즌 × 자산군별"이라면 이쪽은 누적 트랙레코드다.
 */
export async function getAllTimeRanking(
  prisma: PrismaClient,
  sort: RankingSort = 'SCORE',
  now = new Date(),
): Promise<RankingEntry[]> {
  const judgments = await prisma.judgment.findMany({
    select: {
      score: true,
      outcome: true,
      settledPrice: true,
      judgedAt: true,
      predictionCard: {
        select: {
          assetClass: true,
          direction: true,
          basePrice: true,
          report: { select: { researcherId: true } },
        },
      },
    },
  });
  if (judgments.length === 0) return [];

  const byResearcher = new Map<string, typeof judgments>();
  for (const j of judgments) {
    const rid = j.predictionCard.report.researcherId;
    const list = byResearcher.get(rid);
    if (list) list.push(j);
    else byResearcher.set(rid, [j]);
  }

  const profiles = await prisma.researcherProfile.findMany({
    where: { id: { in: [...byResearcher.keys()] } },
    include: { user: { select: { penName: true, email: true } } },
  });

  const entries = profiles
    .map((p) => {
      const js = byResearcher.get(p.id) ?? [];
      const record = computeTrackRecord(js.map(toJudgedPrediction), now);
      return {
        researcherId: p.id,
        name: p.user.penName ?? p.user.email,
        tier: p.tier,
        careerBadge: p.careerBadge,
        totalScore: js.reduce((acc, j) => acc + (j.score ?? 0), 0),
        hitRate: record.hitRate,
        sampleSize: record.sampleSize,
        verifying: record.verifying,
        hypotheticalReturnPct: record.hypotheticalReturnPct,
      };
    })
    .filter((e) => e.sampleSize > 0);

  return sortRanking(entries, sort);
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
