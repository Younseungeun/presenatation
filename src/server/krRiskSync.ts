import type { PrismaClient } from '@prisma/client';
import { toRiskLevel, type RiskLevel } from '@/domain/instrumentRisk';
import type { ProviderRegistry } from '@/domain/marketData';
import { KisMarketDataProvider } from '@/infra/marketData/kisProvider';
import { setInstrumentRisk } from './instrumentService';

// 국내 종목 경보 갱신 — 시장경보(투자주의·경고·위험)·거래정지·정리매매.
//
// 마스터 파일이 주는 것은 관리종목까지다(꼬리 63번). 나머지는 현재가 응답에만 있어
// **종목당 1회**가 필요하므로 전 종목을 돌 수 없다(2,684종목 × 1.1초 = 49분).
// 그래서 실제로 필요한 곳만 본다:
//   · 지금 검증 중인 카드의 종목 — 판정 전에 상태가 바뀌면 알아야 한다
//   · 최근 게시된 카드의 종목 — 게시 검증이 최신값을 봐야 한다
//
// **등급은 올리기만 한다.** 이 자리는 운영자 수동 등록(setInstrumentRisk)과 공유되는데,
// 마스터가 모르는 사유로 사람이 올려 둔 값을 매일 도는 배치가 지우면 경고가 조용히 사라진다.

const RECENT_DAYS = 30;
const RANK: RiskLevel[] = ['NONE', 'CAUTION', 'WARNING', 'DANGER'];

export interface KrRiskSyncSummary {
  checked: number;
  raised: number;
  keptManual: number;
  failed: number;
}

export async function syncKrCardInstrumentRisk(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
): Promise<KrRiskSyncSummary> {
  const provider = registry.KR_EQUITY;
  // 경보는 KIS 응답에서만 나온다 — 다른 공급자면 할 일이 없다
  if (!(provider instanceof KisMarketDataProvider)) {
    return { checked: 0, raised: 0, keptManual: 0, failed: 0 };
  }

  const cards = await prisma.predictionCard.findMany({
    where: {
      assetClass: 'KR_EQUITY',
      OR: [
        { judgment: null, withdrawnAt: null, report: { status: 'PUBLISHED' } },
        { report: { publishedAt: { gte: new Date(now.getTime() - RECENT_DAYS * 86_400_000) } } },
      ],
    },
    select: { ticker: true },
  });
  const tickers = [...new Set(cards.map((c) => c.ticker))];

  const summary: KrRiskSyncSummary = {
    checked: tickers.length,
    raised: 0,
    keptManual: 0,
    failed: 0,
  };

  for (const ticker of tickers) {
    try {
      const signal = await provider.getRiskSignal(ticker);
      const next = toRiskLevel(signal);
      const current = await prisma.instrument.findUnique({
        where: { assetClass_ticker: { assetClass: 'KR_EQUITY', ticker } },
        select: { riskLevel: true, riskNote: true },
      });
      if (!current) continue;

      if (RANK.indexOf(next) < RANK.indexOf(current.riskLevel as RiskLevel)) {
        summary.keptManual++;
        continue;
      }
      if (next === current.riskLevel && (signal.note ?? null) === current.riskNote) continue;

      await setInstrumentRisk(prisma, 'KR_EQUITY', ticker, next, signal.note ?? null, {
        delistingRisk: signal.delisting,
      });
      summary.raised++;
    } catch {
      summary.failed++;
    }
  }

  return summary;
}
