import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, TargetType } from '../src/domain/constants';
import type { DailyQuote, ProviderRegistry } from '../src/domain/marketData';
import { maxMagnitudePct, MIN_MAGNITUDE_PCT } from '../src/domain/scoring';
import { TIER_MAX_PREPAYMENT } from '../src/domain/fees';
import type { Tier } from '../src/domain/constants';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { resolveProvider, toMarketDateString } from '../src/domain/marketData';
import { judgeAndSettleDueCards } from '../src/server/judgmentBatch';
import { runReachedJudgmentBatch } from '../src/server/reachedJudgmentBatch';
import { purchaseReport } from '../src/server/purchaseService';
import { createDraftReport, publishReport } from '../src/server/reportService';

// 실데이터 시드 — npm run seed:real
//
// 기존 시드는 가격을 지어냈다(비트코인 기준가 1억, 삼성전자 7만원). 그래서 화면이
// "목표 반대쪽으로 100%"로 도배되고, 판매 마감 배치를 돌리면 42장 중 32장이 닫혔다.
// 값을 고쳐 봐야 또 지어낸 값이라 무엇이 버그인지 구별할 수 없다.
//
// 그래서 **가격을 하나도 지어내지 않는다**:
//   · 기준가 = 실제 과거 거래일의 종가 (KIS·업비트에서 받은 값)
//   · 현재가 = 지금 실제 시세
//   · 목표는 그 종목의 실제 움직임에 맞춰 정한다 — 예컨대 "적중" 카드는 실제로 이미
//     도달한 폭으로, "역방향" 카드는 실제로 반대로 간 폭의 일부로 잡는다
// 그러면 화면에 뜨는 진행률·괴리·판정이 전부 진짜 시세에서 나온 값이 된다.
//
// 상태를 골고루 만드는 이유는 확인할 것이 상태마다 다르기 때문이다:
//   판매 중(정방향/역방향/근접중단/초과고지) · 판매 마감 · 판정 완료(적중/실패) ·
//   구매한 카드 · 관리종목 · 저변동/고변동 종목

const prisma = new PrismaClient();
const DAY = 86_400_000;

/** 다양성 기준으로 고른 종목 — 대형·중형·고변동·저변동·관리종목이 섞이게 */
const UNIVERSE: Array<{ assetClass: AssetClass; ticker: string; name: string }> = [
  { assetClass: 'KR_EQUITY', ticker: '005930', name: '삼성전자' },
  { assetClass: 'KR_EQUITY', ticker: '000660', name: 'SK하이닉스' },
  { assetClass: 'KR_EQUITY', ticker: '035420', name: 'NAVER' },
  { assetClass: 'KR_EQUITY', ticker: '005380', name: '현대차' },
  { assetClass: 'KR_EQUITY', ticker: '068270', name: '셀트리온' },
  { assetClass: 'KR_EQUITY', ticker: '105560', name: 'KB금융' },
  { assetClass: 'US_EQUITY', ticker: 'AAPL', name: '애플' },
  { assetClass: 'US_EQUITY', ticker: 'NVDA', name: '엔비디아' },
  { assetClass: 'US_EQUITY', ticker: 'TSLA', name: '테슬라' },
  { assetClass: 'US_EQUITY', ticker: 'JPM', name: 'JP모건' },
  { assetClass: 'US_EQUITY', ticker: 'INTC', name: '인텔' },
  { assetClass: 'US_EQUITY', ticker: 'KO', name: '코카콜라' },
  { assetClass: 'CRYPTO', ticker: 'KRW-BTC', name: '비트코인' },
  { assetClass: 'CRYPTO', ticker: 'KRW-ETH', name: '이더리움' },
  { assetClass: 'CRYPTO', ticker: 'KRW-XRP', name: '리플' },
  { assetClass: 'CRYPTO', ticker: 'KRW-SOL', name: '솔라나' },
  { assetClass: 'CRYPTO', ticker: 'KRW-DOGE', name: '도지코인' },
];

const RESEARCHERS = [
  { pen: '정량리서치랩', tier: 'PLATINUM', badge: 'ANALYST', bio: '퀀트 기반 중기 스윙. 통계적 우위가 확인된 구간만 씁니다.' },
  { pen: '반도체체크', tier: 'GOLD', badge: 'ANALYST', bio: '반도체 공급망·설비투자 추적 8년차.' },
  { pen: '매크로노트', tier: 'GOLD', badge: null, bio: '금리·환율에서 출발해 업종을 고릅니다.' },
  { pen: '코인온체인', tier: 'SILVER', badge: null, bio: '온체인 지표와 거래소 유출입 중심.' },
  { pen: '가치투자연구소', tier: 'SILVER', badge: 'CFA', bio: '저평가 대형주 위주, 분기 실적 기반.' },
  { pen: '신입애널', tier: 'BRONZE', badge: null, bio: '이제 막 시작했습니다. 전액 환불 조건으로 검증받겠습니다.' },
];

/** 호가 단위로 반올림 — 목표가가 000으로 끝나는 가짜 티가 안 나게 */
function roundTick(assetClass: AssetClass, price: number): number {
  if (assetClass === 'US_EQUITY') return Math.round(price * 100) / 100;
  if (assetClass === 'CRYPTO') {
    if (price < 1) return Math.round(price * 1000) / 1000;
    if (price < 10) return Math.round(price * 100) / 100;
    if (price < 100) return Math.round(price * 10) / 10;
    if (price < 1_000) return Math.round(price);
    if (price < 10_000) return Math.round(price / 5) * 5;
    if (price < 100_000) return Math.round(price / 10) * 10;
    if (price < 1_000_000) return Math.round(price / 100) * 100;
    return Math.round(price / 1000) * 1000;
  }
  // 국내주식 호가단위
  const tick =
    price < 2_000 ? 1 : price < 5_000 ? 5 : price < 20_000 ? 10 : price < 50_000 ? 50 : price < 200_000 ? 100 : price < 500_000 ? 500 : 1_000;
  return Math.round(price / tick) * tick;
}

interface Series {
  assetClass: AssetClass;
  ticker: string;
  name: string;
  quotes: DailyQuote[];
}

/** 게시 시점의 세계를 재현하는 레지스트리 — 현재가는 그 날의 종가다 */
function registryAt(s: Series, upTo: string): ProviderRegistry {
  const quotes = s.quotes.filter((q) => q.date <= upTo);
  const last = quotes[quotes.length - 1];
  const p = new FixtureMarketDataProvider()
    .setCurrentPrice(s.ticker, last.close)
    .setQuotes(s.ticker, quotes);
  return { [s.assetClass]: p } as ProviderRegistry;
}

/** 판정용 — 전 구간(오늘까지) 실제 종가 */
function registryFull(all: Series[]): ProviderRegistry {
  const reg: ProviderRegistry = {};
  for (const ac of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    const mine = all.filter((s) => s.assetClass === ac);
    if (mine.length === 0) continue;
    const p = new FixtureMarketDataProvider();
    for (const s of mine) {
      p.setQuotes(s.ticker, s.quotes);
      p.setCurrentPrice(s.ticker, s.quotes[s.quotes.length - 1].close);
    }
    reg[ac] = p;
  }
  return reg;
}

async function fetchSeries(): Promise<Series[]> {
  const live = createDefaultRegistry();
  const now = new Date();
  const out: Series[] = [];
  for (const u of UNIVERSE) {
    try {
      const to = toMarketDateString(now, u.assetClass);
      const from = toMarketDateString(new Date(now.getTime() - 150 * DAY), u.assetClass);
      const quotes = await resolveProvider(live, u.assetClass).getDailyQuotes(u.ticker, from, to);
      if (quotes.length < 40) {
        console.log(`  ✗ ${u.name}: 일봉 ${quotes.length}건 — 건너뜀`);
        continue;
      }
      out.push({ ...u, quotes });
      const first = quotes[0].close;
      const last = quotes[quotes.length - 1].close;
      console.log(
        `  ✓ ${u.name.padEnd(8)} ${quotes.length}일 ${quotes[0].date}~${quotes[quotes.length - 1].date} ` +
          `${first} → ${last} (${(((last - first) / first) * 100).toFixed(1)}%)`,
      );
    } catch (e) {
      console.log(`  ✗ ${u.name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** 시리즈에서 특정 날짜 이하의 마지막 종가 */
function closeAt(s: Series, date: string): DailyQuote | null {
  const rows = s.quotes.filter((q) => q.date <= date);
  return rows[rows.length - 1] ?? null;
}

type Intent =
  | 'HIT' // 시한 지남 + 이미 도달 → 적중 판정
  | 'MISS' // 시한 지남 + 미달 → 실패 판정
  | 'FORWARD' // 판매 중, 정방향 진행
  | 'ADVERSE' // 판매 중, 역방향 진행 (붉은 막대)
  | 'NEAR' // 목표 근접 → 결제 중단(q<0.5)
  | 'CLOSED'; // 판매 기간 종료(WINDOW_END)

interface Plan {
  series: Series;
  intent: Intent;
  publishedAt: Date;
  deadline: Date;
  direction: Direction;
  targetType: TargetType;
  magnitudePct: number;
  confidence: number;
  priceKrw: number;
  prepaymentRatio: number;
  researcherIdx: number;
  title: string;
}

/**
 * 실제 가격 흐름에서 의도한 상태가 나오도록 목표 크기를 역산한다.
 * 가격을 지어내지 않고 **목표만 고르는** 방식이라 결과가 진짜 시세에서 나온다.
 */
function planFor(
  s: Series,
  intent: Intent,
  now: Date,
  idx: number,
  shortable: boolean,
): Plan | null {
  const floor = MIN_MAGNITUDE_PCT[s.assetClass];
  // 판매 기간 = min(검증기간/3, 30일)이라, "판매 중"이어야 하는 상태는 게시 시점을
  // 그 안쪽으로 잡아야 한다. 처음엔 20일 전 게시 + 60일 시한으로 잡았다가 판매 기간이
  // 정확히 끝나 버려 리더보드가 통째로 비었다(실제로 그렇게 나왔다).
  const horizonDays = intent === 'HIT' || intent === 'MISS' ? 45 : intent === 'CLOSED' ? 21 : 120;
  const publishedDaysAgo = intent === 'HIT' || intent === 'MISS' ? 60 : intent === 'CLOSED' ? 18 : 15;

  const publishedAt = new Date(now.getTime() - publishedDaysAgo * DAY);
  const deadline = new Date(publishedAt.getTime() + horizonDays * DAY);
  const pubDate = toMarketDateString(publishedAt, s.assetClass);
  const base = closeAt(s, pubDate);
  if (!base) return null;

  const window = s.quotes.filter((q) => q.date > pubDate && q.date <= toMarketDateString(deadline < now ? deadline : now, s.assetClass));
  if (window.length < 5) return null;

  const closes = window.map((q) => q.close);
  const maxUp = (Math.max(...closes) / base.close - 1) * 100;
  const maxDown = (1 - Math.min(...closes) / base.close) * 100;
  const lastClose = closes[closes.length - 1];
  const nowPct = (lastClose / base.close - 1) * 100;

  // 방향은 실제 흐름에서 고른다 — 의도한 상태가 나오는 쪽으로
  let direction: Direction;
  let magnitudePct: number;

  switch (intent) {
    case 'HIT': {
      // 실제로 도달한 폭의 70% → 확실히 적중
      direction = maxUp >= maxDown ? 'UP' : 'DOWN';
      const reach = direction === 'UP' ? maxUp : maxDown;
      if (reach < floor * 1.2) return null;
      magnitudePct = Math.max(floor, reach * 0.7);
      break;
    }
    case 'MISS': {
      // 실제 도달 폭의 1.8배 → 미달 확정
      direction = maxUp >= maxDown ? 'UP' : 'DOWN';
      const reach = Math.max(direction === 'UP' ? maxUp : maxDown, floor);
      magnitudePct = Math.max(floor * 1.5, reach * 1.8);
      break;
    }
    case 'FORWARD': {
      // 지금 진행률 40~60%가 되도록
      direction = nowPct >= 0 ? 'UP' : 'DOWN';
      const moved = Math.abs(nowPct);
      if (moved < floor * 0.4) return null;
      magnitudePct = Math.max(floor, moved / 0.5);
      break;
    }
    case 'ADVERSE': {
      // 실제 움직임의 반대로 걸어 역방향 50~70% 상태를 만든다
      direction = nowPct >= 0 ? 'DOWN' : 'UP';
      const against = Math.abs(nowPct);
      if (against < floor * 0.5) return null;
      magnitudePct = Math.max(floor, against / 0.6);
      break;
    }
    case 'NEAR': {
      // 남은 폭이 광고의 절반 밑 → 결제 중단 상태
      direction = nowPct >= 0 ? 'UP' : 'DOWN';
      const moved = Math.abs(nowPct);
      if (moved < floor * 0.8) return null;
      magnitudePct = Math.max(floor, moved / 0.75);
      break;
    }
    case 'CLOSED': {
      direction = nowPct >= 0 ? 'UP' : 'DOWN';
      magnitudePct = Math.max(floor, Math.abs(nowPct) * 1.5, floor * 1.4);
      break;
    }
  }

  // 하락 예측은 숏 수단이 있는 종목만 — 규칙을 우회하지 않고 그 조합을 건너뛴다
  // (다른 종목의 실제 흐름이 반대라 같은 상태가 그쪽에서 만들어진다)
  if (direction === 'DOWN' && !shortable) return null;

  // 게시 검증과 같은 상한을 적용한다 — 넘으면 "비현실적 목표"로 게시가 막힌다
  magnitudePct = Math.min(magnitudePct, maxMagnitudePct(s.assetClass, horizonDays) * 0.9);
  magnitudePct = Math.round(Math.max(magnitudePct, floor) * 10) / 10;
  // 목표가형과 수익률형을 섞는다 — 두 표기가 화면에서 어떻게 보이는지 함께 확인해야 한다
  const targetType: TargetType = idx % 3 === 0 ? 'TARGET_PRICE' : 'RETURN_PCT';

  const dirWord = direction === 'UP' ? '상승' : '조정';
  const titles = [
    `${s.name} ${dirWord} 모멘텀 점검`,
    `${s.name}, 지금 구간에서 볼 것`,
    `${s.name} ${magnitudePct.toFixed(0)}% ${dirWord} 시나리오`,
    `${s.name} 수급·밸류 재점검`,
  ];

  return {
    series: s,
    intent,
    publishedAt,
    deadline,
    direction,
    targetType,
    magnitudePct,
    confidence: [2, 3, 3, 4, 5, 6][idx % 6],
    priceKrw: [5_900, 9_900, 12_900, 19_900, 29_000, 39_000][idx % 6],
    // 선결제는 등급별 상한이 있다 (fees.TIER_MAX_PREPAYMENT) — 실제 해금 규칙을 따른다
    prepaymentRatio: 0,
    researcherIdx: idx % RESEARCHERS.length,
    title: titles[idx % titles.length],
  };
}

async function wipe() {
  // 데모 데이터만 지운다 — 종목 마스터(Instrument)와 운영 설정(AppSetting)은 남긴다
  await prisma.corporateActionLog.deleteMany();
  await prisma.settlement.deleteMany();
  await prisma.judgment.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.paymentIntent.deleteMany();
  await prisma.cartItem.deleteMany();
  await prisma.predictionCard.deleteMany();
  await prisma.complianceReview.deleteMany();
  await prisma.abuseReport.deleteMany();
  await prisma.report.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.follow.deleteMany();
  await prisma.tierHistory.deleteMany();
  await prisma.consent.deleteMany();
  await prisma.researcherProfile.deleteMany();
  await prisma.user.deleteMany();
}

async function main() {
  const now = new Date();
  console.log('1) 실시세 수집');
  const series = await fetchSeries();
  if (series.length === 0) throw new Error('시세를 하나도 받지 못했습니다');

  console.log('\n2) 기존 데모 데이터 삭제');
  await wipe();

  console.log('3) 리서처·구매자 생성');
  const researcherIds: string[] = [];
  for (const r of RESEARCHERS) {
    const u = await prisma.user.create({
      data: {
        email: `${r.pen}@demo.local`,
        penName: r.pen,
        identityVerified: true,
        researcherProfile: {
          create: { tier: r.tier, careerBadge: r.badge, bio: r.bio },
        },
      },
      include: { researcherProfile: true },
    });
    researcherIds.push(u.researcherProfile!.id);
  }
  const buyers = await Promise.all(
    ['구매자김', '구매자이', '구매자박'].map((pen, i) =>
      prisma.user.create({
        data: { email: `buyer${i}@demo.local`, penName: pen, identityVerified: true },
      }),
    ),
  );

  console.log('4) 카드 게시 (기준가 = 실제 과거 종가)');
  // 하락 예측 가능 여부는 종목 마스터가 단일 기준이다 — 시드도 같은 값을 본다
  const shortableRows = await prisma.instrument.findMany({
    where: { ticker: { in: series.map((s) => s.ticker) } },
    select: { assetClass: true, ticker: true, shortable: true },
  });
  const shortable = new Map(shortableRows.map((r) => [`${r.assetClass}:${r.ticker}`, r.shortable]));
  const INTENTS: Intent[] = ['HIT', 'MISS', 'FORWARD', 'ADVERSE', 'NEAR', 'CLOSED'];
  const published: Array<{ reportId: string; plan: Plan }> = [];
  let idx = 0;
  for (const intent of INTENTS) {
    for (const s of series) {
      // 상태마다 종목을 돌려 가며 골라 자산군이 골고루 섞이게
      if ((series.indexOf(s) + INTENTS.indexOf(intent)) % 3 !== 0) continue;
      const plan = planFor(s, intent, now, idx, shortable.get(`${s.assetClass}:${s.ticker}`) ?? false);
      if (!plan) continue;
      try {
        const draft = await createDraftReport(
          prisma,
          {
            researcherId: researcherIds[plan.researcherIdx],
            title: plan.title,
            summary: `${s.name}에 대한 ${plan.direction === 'UP' ? '상승' : '하락'} 예측입니다.`,
            content:
              `## 요약\n\n${s.name}의 최근 흐름과 수급을 점검했습니다. ` +
              `기준 시점 대비 목표 구간까지의 경로와 되돌림 위험을 함께 정리합니다.\n\n` +
              `## 근거\n\n1. 최근 거래대금과 변동성이 직전 분기 대비 유의미하게 변했습니다.\n` +
              `2. 동종 업종 대비 상대 강도가 바뀌는 구간입니다.\n` +
              `3. 검증 시한 내 촉매(실적·이벤트)가 존재합니다.\n\n` +
              `## 리스크\n\n시나리오가 무효화되는 조건과 되돌림 구간을 본문에 적었습니다.`,
            priceKrw: plan.priceKrw,
            // 등급이 허용하는 만큼만 — 상위 등급 카드에서 선결제 표기도 확인되게
            prepaymentRatio:
              plan.priceKrw === 0
                ? 0
                : idx % 3 === 0
                  ? TIER_MAX_PREPAYMENT[RESEARCHERS[plan.researcherIdx].tier as Tier]
                  : 0,
            card: {
              assetClass: s.assetClass,
              ticker: s.ticker,
              assetName: s.name,
              direction: plan.direction,
              targetType: plan.targetType,
              targetValue:
                plan.targetType === 'RETURN_PCT'
                  ? plan.magnitudePct
                  : roundTick(
                      s.assetClass,
                      closeAt(s, toMarketDateString(plan.publishedAt, s.assetClass))!.close *
                        (1 + (plan.direction === 'UP' ? 1 : -1) * (plan.magnitudePct / 100)),
                    ),
              confidence: plan.confidence,
              selfStability: 1,
              deadline: plan.deadline,
            },
          },
          new Date(plan.publishedAt.getTime() - DAY),
        );
        await publishReport(
          prisma,
          registryAt(s, toMarketDateString(plan.publishedAt, s.assetClass)),
          draft.id,
          researcherIds[plan.researcherIdx],
          plan.publishedAt,
        );
        published.push({ reportId: draft.id, plan });
        idx++;
      } catch (e) {
        console.log(`  ✗ ${s.name} [${intent}]: ${(e as Error).message}`);
      }
    }
  }
  console.log(`  게시 ${published.length}장`);

  console.log('5) 구매 생성');
  let bought = 0;
  for (const [i, p] of published.entries()) {
    if (p.plan.priceKrw === 0) continue;
    // 절반 정도만 팔린 상태로 — "아직 첫 구매 전" 카드도 화면에 있어야 한다
    if (i % 2 === 1) continue;
    for (const buyer of buyers.slice(0, (i % 3) + 1)) {
      try {
        await purchaseReport(
          prisma,
          p.reportId,
          buyer.id,
          new Date(p.plan.publishedAt.getTime() + DAY),
        );
        bought++;
      } catch {
        /* 시한·중단 규칙에 걸리면 건너뛴다 — 그것도 현실적인 상태다 */
      }
    }
  }
  console.log(`  구매 ${bought}건`);

  console.log('6) 판정 배치 (실제 종가로)');
  const full = registryFull(series);
  const reached = await runReachedJudgmentBatch(prisma, full, now);
  const due = await judgeAndSettleDueCards(prisma, full, now);
  console.log(`  도달 판정 ${reached.judged}건 / 기한 판정 ${due.judged}건`);

  const summary = await prisma.predictionCard.groupBy({ by: ['assetClass'], _count: true });
  console.log('\n완료 —', summary.map((s) => `${s.assetClass} ${s._count}장`).join(' / '));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
