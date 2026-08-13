import 'dotenv/config';
import { resolveProvider } from '../src/domain/marketData';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import type { AssetClass } from '../src/domain/constants';
import { estimateDailySigma } from '../src/domain/stability';
import {
  claimedProbability,
  DISCIPLINE_ALPHA,
  evidenceThreshold,
  minMagnitudePct,
  noSkillTouchProbability,
} from '../src/domain/scoring';
import { aggregateEvidence, type EvidenceCard } from '../src/domain/evidence';
// 급변장에서 래더가 정직한 리서처를 쓸어버리는가 — npx tsx scripts/simRegimeShift.ts
//

// ── 왜 이걸 재나 ──────────────────────────────────────────────
// 카드를 낼 때 그 종목의 변동성 σ를 재서 **게시 순간에 고정**한다. σ가 무정보 도달
// 확률 p₀를 정하고, p₀가 채점의 기준선이다. 그런데 시장 국면이 바뀌면 게시 시점의
// σ와 이후 실제 시장이 크게 어긋난다.
//
// 특히 위험한 방향이 있다. 변동성이 튀면 **양쪽 장벽 모두 닿기 쉬워지지만**, 폭락장의
// 드리프트는 한쪽으로만 강하게 작용한다. 리서치는 대체로 상승 편향이므로,
// **폭락장에서 상승 카드가 무더기로 틀린다** — 그것도 서로 같은 이유로.
//
// 그러면 정직한 리서처들의 D가 **함께** 내려가고 동시에 ★3 제한을 맞는다.
// 규율 시스템이 낼 수 있는 가장 비싼 오작동이다: 잘못 잡힌 사람이 수백 명이고,
// 하필 시장이 가장 불안해 정보가 가장 필요한 때에 일어난다.
//
// 외부 검토는 이것을 "래더 밖의 서킷 브레이커 운영 규칙으로 풀라"고 했다. 맞는 말이나
// **그 규칙이 존재하지 않고, 문제 크기를 잰 적도 없다.** 발동 조건을 지어내기 전에
// 실제 급변장 데이터로 크기부터 잰다.
//

// ── 무엇을 재나 ───────────────────────────────────────────────
// 실제 일봉으로 카드를 굴린다. 고정된 신고 정책(상승·하한 크기·신뢰도 c)을 두고
//   ① 모델이 말한 p₀ vs **실제 도달률** — 국면별로 얼마나 어긋나나
//   ② 그 어긋남이 D를 얼마나 끌어내리나 — 문턱(−2.30)에 닿는가
// 를 월별로 본다. 리서처의 정직 여부를 판정하는 것이 아니라, **같은 정책의 D가
// 국면 사이에서 얼마나 흔들리는지**를 보는 것이다.

/**
 * 잴 국면들. **코로나 하나로는 결론을 낼 수 없다** — 코로나는 급락 후 급반등이라
 * 회복이 빨랐고, 오래 끄는 약세장은 다르게 반응할 수 있다. 성격이 다른 넷을 본다:
 *
 *   · 닷컴 붕괴(2000~01) — 오래 끄는 붕괴. 국내주식만 데이터가 닿는다
 *   · 금융위기(2008~09) — 급락 + 유동성 경색. 국내·미국
 *   · 코로나(2020) — 급락 후 급반등. 전 자산군
 *   · 2022 약세장 — **σ가 크게 안 뛰면서 드리프트만 계속 불리한** 국면.
 *     상쇄가 안 일어나므로 가장 위험할 것으로 의심되는 자리다
 *
 * 각 시대의 종목은 그 시절에 상장돼 있던 것만 쓴다(데이터가 없으면 자동으로 걸러진다).
 */
interface Era {
  name: string;
  from: string;
  to: string;
  universe: Partial<Record<AssetClass, string[]>>;
  /** 구간 라벨 — 첫 번째가 평상(기준선)이어야 σ 배수가 뜻을 가진다 */
  periods: [string, string, string][];
  /** 이 구간에 데이터가 없는 종목은 버린다 */
  crash: [string, string];
}

const KR_OLD = ['005930', '000660', '005380', '051910'];
const US_MID = ['AAPL', 'MSFT', 'JPM', 'XOM', 'DIS'];

const ERAS: Era[] = [
  {
    name: '닷컴 붕괴 (2000~2001)',
    from: '1999-01-01',
    to: '2002-12-31',
    universe: { KR_EQUITY: KR_OLD },
    crash: ['2000-04-01', '2001-09-30'],
    periods: [
      ['평상(1999)', '1999-01-01', '1999-12-31'],
      ['**붕괴 1차**', '2000-01-01', '2000-12-31'],
      ['**여진**', '2001-01-01', '2001-09-30'],
      ['회복(2002)', '2001-10-01', '2002-12-31'],
    ],
  },
  {
    name: '금융위기 (2008~2009)',
    from: '2007-01-01',
    to: '2009-12-31',
    universe: { KR_EQUITY: KR_OLD, US_EQUITY: US_MID },
    crash: ['2008-09-01', '2009-03-31'],
    periods: [
      ['평상(2007)', '2007-01-01', '2007-12-31'],
      ['균열', '2008-01-01', '2008-08-31'],
      ['**위기**', '2008-09-01', '2009-03-31'],
      ['회복', '2009-04-01', '2009-12-31'],
    ],
  },
  {
    name: '코로나 (2020)',
    from: '2019-01-01',
    to: '2021-12-31',
    universe: {
      KR_EQUITY: ['005930', '000660', '035420', '051910', '005380', '068270'],
      US_EQUITY: ['AAPL', 'MSFT', 'JPM', 'XOM', 'NVDA', 'DIS'],
      CRYPTO: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
    },
    crash: ['2020-02-15', '2020-04-15'],
    periods: [
      ['평상(2019)', '2019-01-01', '2019-12-31'],
      ['**폭락**', '2020-02-15', '2020-04-15'],
      ['반등', '2020-04-16', '2020-12-31'],
      ['평상(2021)', '2021-01-01', '2021-12-31'],
    ],
  },
  {
    name: '2022 약세장',
    from: '2021-01-01',
    to: '2023-06-30',
    universe: {
      KR_EQUITY: ['005930', '000660', '035420', '051910', '005380', '068270'],
      US_EQUITY: ['AAPL', 'MSFT', 'JPM', 'XOM', 'NVDA', 'DIS'],
      CRYPTO: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
    },
    crash: ['2022-01-01', '2022-10-31'],
    periods: [
      ['평상(2021)', '2021-01-01', '2021-12-31'],
      ['**약세 전반**', '2022-01-01', '2022-06-30'],
      ['**약세 후반**', '2022-07-01', '2022-10-31'],
      ['회복', '2022-11-01', '2023-06-30'],
    ],
  },
];

const HORIZON = 30; // 거래일
const CADENCE = 6; // 거래일마다 한 장 (자산군당 활성 5장 × 기한 30일)

/**
 * 신고 정책. **정직한 값을 데이터에서 찾아야 한다** — 처음에 c=5로 돌렸더니 모든
 * 구간에서 D가 내려갔는데, 그것은 국면 문제가 아니라 c=5가 p̂≈70%를 신고하는 값이라
 * 실제 도달률(20~35%)과 애초에 맞지 않았기 때문이다. 래더가 제 일을 한 것이지
 * 급변장 때문이 아니다. **시대마다 평상 구간에서 정직한 자리를 다시 찾고**,
 * 그 자리에서 국면 간 차이를 본다.
 */
let CONFIDENCE = 2;

const RUNG1 = evidenceThreshold(DISCIPLINE_ALPHA[0]); // −2.30
const RUNG2 = evidenceThreshold(DISCIPLINE_ALPHA[1]); // −4.61

interface Bar {
  date: string;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * **연도별로 나눠 받는다.** KIS 일봉은 100건씩 최대 3페이지(=300건)만 이어 붙이므로
 * (infra/marketData/kisProvider.pagedDaily), 여러 해를 한 번에 달라고 하면
 * **최근 300건만** 온다 — 실측으로 확인했다. 프로덕션은 120거래일 창만 쓰므로 그
 * 상한이 맞는 값이다. 그래서 공급자를 고치지 않고 여기서 구간을 쪼갠다.
 */
async function loadBars(era: Era): Promise<Map<string, { assetClass: AssetClass; bars: Bar[] }>> {
  const registry = createDefaultRegistry();
  const out = new Map<string, { assetClass: AssetClass; bars: Bar[] }>();
  const y0 = Number(era.from.slice(0, 4));
  const y1 = Number(era.to.slice(0, 4));
  for (const [assetClass, tickers] of Object.entries(era.universe) as [AssetClass, string[]][]) {
    const provider = resolveProvider(registry, assetClass);
    for (const ticker of tickers) {
      try {
        const merged = new Map<string, Bar>();
        for (let y = y0; y <= y1; y++) {
          const chunk = await provider.getDailyQuotes(ticker, `${y}-01-01`, `${y}-12-31`);
          for (const b of chunk) {
            merged.set(b.date, {
              date: b.date,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume ?? 1,
            });
          }
          if (assetClass === 'CRYPTO') await sleep(400); // 업비트 초당 제한
        }
        const bars = [...merged.values()]
          .filter((b) => b.close > 0 && b.high > 0 && b.low > 0)
          .sort((a, b) => a.date.localeCompare(b.date));
        // 그 시대의 급변 구간이 실제로 들어 있는지 확인한다 — 없으면 쓸모없는 종목이다
        const inCrash = bars.filter((b) => b.date >= era.crash[0] && b.date <= era.crash[1]).length;
        if (bars.length < 400 || inCrash < 20) {
          console.log(`\n  · ${ticker}: ${bars.length}건 / 급변 구간 ${inCrash}건 — 건너뜀`);
          continue;
        }
        out.set(`${assetClass}:${ticker}`, { assetClass, bars });
        process.stdout.write('.');
      } catch (e) {
        console.log(`\n  · ${ticker} 실패: ${(e as Error).message.slice(0, 60)}`);
      }
    }
  }
  process.stdout.write('\n');
  return out;
}

interface Card {
  assetClass: AssetClass;
  openDate: string;
  closeDate: string;
  /** 게시 시점에 잰 σ (production과 같은 추정기) */
  sigma: number;
  p0: number;
  hit: boolean;
  info: number;
}

/** 한 종목에서 낼 수 있는 카드를 전부 만든다 — 실제 종가로 판정까지 */
function buildCards(assetClass: AssetClass, bars: Bar[]): Card[] {
  const cards: Card[] = [];
  const WARMUP = 120; // σ 추정에 필요한 창
  for (let i = WARMUP; i + HORIZON < bars.length; i += CADENCE) {
    const window = bars.slice(Math.max(0, i - 120), i);
    const sigma = estimateDailySigma(
      {
        closes: window.map((b) => b.close),
        highs: window.map((b) => b.high),
        lows: window.map((b) => b.low),
        volumes: window.map((b) => b.volume),
      },
      assetClass,
    );
    if (sigma == null) continue;

    const magnitudePct = minMagnitudePct(assetClass, sigma, HORIZON);
    const p0 = noSkillTouchProbability('UP', magnitudePct, assetClass, HORIZON, sigma);
    const pHat = claimedProbability(p0, CONFIDENCE);

    const target = bars[i].close * (1 + magnitudePct / 100);
    let hit = false;
    for (let j = i + 1; j <= i + HORIZON; j++) {
      if (bars[j].close >= target) {
        hit = true;
        break;
      }
    }
    cards.push({
      assetClass,
      openDate: bars[i].date,
      closeDate: bars[Math.min(i + HORIZON, bars.length - 1)].date,
      sigma,
      p0,
      hit,
      info: hit ? Math.log(pHat / p0) : Math.log((1 - pHat) / (1 - p0)),
    });
  }
  return cards;
}

/** 그 카드 묶음을 신뢰도 c로 채점했을 때의 카드당 정보량 */
const infoAt = (cards: Card[], c: number) =>
  cards.reduce((a, k) => {
    const ph = claimedProbability(k.p0, c);
    return a + (k.hit ? Math.log(ph / k.p0) : Math.log((1 - ph) / (1 - k.p0)));
  }, 0) / Math.max(1, cards.length);

async function runEra(era: Era): Promise<void> {
  console.log(`\n${'='.repeat(74)}`);
  console.log(`■ ${era.name}   (${era.from} ~ ${era.to})`);
  process.stdout.write('  시세 ');
  const data = await loadBars(era);
  if (data.size === 0) {
    console.log('  쓸 수 있는 종목이 없다 — 건너뜀');
    return;
  }

  const build = () => {
    const out: Card[] = [];
    for (const { assetClass, bars } of data.values()) out.push(...buildCards(assetClass, bars));
    return out.sort((a, b) => a.openDate.localeCompare(b.openDate));
  };
  let all = build();
  const [calmLabel, calmFrom, calmTo] = era.periods[0];

  // ── 평상 구간에서 정직한 신뢰도를 찾는다 ──────────────────
  const calm = all.filter((c) => c.openDate >= calmFrom && c.openDate <= calmTo);
  let honestC = 2;
  let bestGap = Infinity;
  for (let c = 2; c <= 10; c++) {
    const gap = Math.abs(infoAt(calm, c));
    if (gap < bestGap) {
      bestGap = gap;
      honestC = c;
    }
  }
  CONFIDENCE = honestC;
  all = build();
  console.log(
    `  종목 ${data.size}개 · 카드 ${all.length}장 · ${calmLabel}에서 정직한 신뢰도 **c=${honestC}** (정보량 ${infoAt(calm, honestC).toFixed(3)})\n`,
  );

  // ── 구간별 ────────────────────────────────────────────────
  const base = all.filter((c) => c.openDate >= calmFrom && c.openDate <= calmTo);
  const baseSigma = base.reduce((a, c) => a + c.sigma, 0) / Math.max(1, base.length);
  console.log(
    `  ${'구간'.padEnd(15)}${'카드'.padStart(6)}${'모델 p₀'.padStart(9)}${'실제'.padStart(8)}${'카드당 정보량'.padStart(14)}${'σ 배수'.padStart(9)}`,
  );
  for (const [label, from, to] of era.periods) {
    const g = all.filter((c) => c.openDate >= from && c.openDate <= to);
    if (g.length === 0) continue;
    const p0 = g.reduce((a, c) => a + c.p0, 0) / g.length;
    const real = g.filter((c) => c.hit).length / g.length;
    const info = g.reduce((a, c) => a + c.info, 0) / g.length;
    const sig = g.reduce((a, c) => a + c.sigma, 0) / g.length;
    console.log(
      `  ${label.padEnd(15)}${String(g.length).padStart(6)}${((p0 * 100).toFixed(1) + '%').padStart(9)}` +
        `${((real * 100).toFixed(1) + '%').padStart(8)}${info.toFixed(3).padStart(14)}` +
        `${(sig / baseSigma).toFixed(2) + '배'}`.padStart(9),
    );
  }

  // ── 증거 D가 실제로 어디까지 내려가나 ─────────────────────
  console.log(
    `\n  ${'자산군'.padEnd(11)}${'카드'.padStart(6)}${'최저 D'.padStart(9)}  ${'최저 시점'.padStart(10)}  ${'1단 도달'.padStart(10)}  ${'2단 도달'.padStart(10)}`,
  );
  for (const assetClass of Object.keys(era.universe) as AssetClass[]) {
    const cards = all.filter((c) => c.assetClass === assetClass);
    if (cards.length === 0) continue;
    const judged: EvidenceCard[] = [];
    let minD = 0;
    let minAt = '';
    let hit1 = '';
    let hit2 = '';
    for (const c of [...cards].sort((a, b) => a.closeDate.localeCompare(b.closeDate))) {
      judged.push({
        assetClass,
        direction: 'UP',
        openedAt: Date.parse(c.openDate),
        closedAt: Date.parse(c.closeDate),
        info: c.info,
      });
      const d = aggregateEvidence(judged)[assetClass];
      if (d < minD) {
        minD = d;
        minAt = c.closeDate;
      }
      if (!hit1 && d <= RUNG1) hit1 = c.closeDate;
      if (!hit2 && d <= RUNG2) hit2 = c.closeDate;
    }
    console.log(
      `  ${assetClass.padEnd(11)}${String(cards.length).padStart(6)}${minD.toFixed(2).padStart(9)}` +
        `  ${(minAt || '—').padStart(10)}  ${(hit1 || '—').padStart(10)}  ${(hit2 || '—').padStart(10)}`,
    );
  }
}

async function main() {
  console.log('\n■ 급변장에서 래더가 정직한 리서처를 쓸어버리는가 — 실제 일봉');
  console.log('  정책: 상승 · 크기 = 하한(1.2·σ·√30) · 평상 구간에서 정직한 신뢰도 · 6거래일마다 1장');
  console.log('  σ는 production과 같은 추정기(종가 120일 + Parkinson 10일)로 게시 시점에 고정');
  for (const era of ERAS) await runEra(era);
  console.log('');
}

main();

