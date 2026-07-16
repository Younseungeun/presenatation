import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import type { InstrumentListing } from '../src/domain/marketData';
import { SHORTABLE_STOCKS } from '../src/domain/shortableUniverse';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { applyInstrumentListings, syncAllInstruments } from '../src/server/instrumentService';

// 종목 마스터 동기화: npm run sync:instruments [-- --fixture]
// - 기본: 시세 공급자의 상장 목록 API에서 동기화
//   (업비트 market/all은 키 불필요 / KR은 FSC_API_KEY, US는 TWELVEDATA_API_KEY 필요)
// - --fixture: 오프라인 개발용 고정 목록 시드 (공급자 호출 없음)
// 운영은 이 스크립트를 일 배치로 돌려 상장·상폐를 반영한다.

/** 오프라인 개발용 고정 목록 — 숏 가능 유니버스 + 대표 종목 약간 */
function fixtureListings(): Record<AssetClass, InstrumentListing[]> {
  const kr: InstrumentListing[] = [
    ...SHORTABLE_STOCKS.KR_EQUITY.map((s) => ({ ...s, currency: 'KRW' })),
    // 숏 불가(개별주식선물 미상장) 대표 종목 — 상승 예측 전용
    { ticker: '042700', name: '한미반도체', currency: 'KRW' },
    { ticker: '028300', name: 'HLB', currency: 'KRW' },
    { ticker: '277810', name: '레인보우로보틱스', currency: 'KRW' },
    { ticker: '095340', name: 'ISC', currency: 'KRW' },
    { ticker: '036930', name: '주성엔지니어링', currency: 'KRW' },
  ];
  const us: InstrumentListing[] = [
    ...SHORTABLE_STOCKS.US_EQUITY.map((s) => ({ ...s, currency: 'USD' })),
    // 인버스 싱글스톡 ETF 없는 종목 — 상승 예측 전용
    { ticker: 'KO', name: 'Coca-Cola', currency: 'USD' },
    { ticker: 'PFE', name: 'Pfizer', currency: 'USD' },
    { ticker: 'GE', name: 'GE Aerospace', currency: 'USD' },
    { ticker: 'F', name: 'Ford Motor', currency: 'USD' },
    { ticker: 'SNAP', name: 'Snap', currency: 'USD' },
    { ticker: 'BRK.B', name: 'Berkshire Hathaway B', currency: 'USD' },
  ];
  const crypto: InstrumentListing[] = [
    ['KRW-BTC', '비트코인'],
    ['KRW-ETH', '이더리움'],
    ['KRW-SOL', '솔라나'],
    ['KRW-XRP', '엑스알피(리플)'],
    ['KRW-DOGE', '도지코인'],
    ['KRW-ADA', '에이다'],
    ['KRW-AVAX', '아발란체'],
    ['KRW-LINK', '체인링크'],
    ['KRW-DOT', '폴카닷'],
    ['KRW-TRX', '트론'],
  ].map(([ticker, name]) => ({ ticker, name, currency: 'KRW' }));
  return { KR_EQUITY: kr, US_EQUITY: us, CRYPTO: crypto };
}

async function main() {
  const fixture = process.argv.includes('--fixture');
  const prisma = new PrismaClient();
  try {
    if (fixture) {
      for (const [assetClass, listings] of Object.entries(fixtureListings())) {
        const r = await applyInstrumentListings(
          prisma,
          assetClass as AssetClass,
          'seed',
          listings,
        );
        console.log(`${r.assetClass}: ${r.upserted}종 시드 (비활성 전환 ${r.deactivated})`);
      }
      return;
    }

    const results = await syncAllInstruments(prisma, createDefaultRegistry());
    if (results.length === 0) {
      console.error('목록 조회를 지원하는 공급자가 없습니다 — API 키(FSC/TWELVEDATA)를 확인하세요');
      process.exit(1);
    }
    for (const r of results) {
      console.log(`${r.assetClass} ← ${r.source}: ${r.upserted}종 동기화 (비활성 전환 ${r.deactivated})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
