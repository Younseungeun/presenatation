import 'dotenv/config';
import { resolveProvider } from '../src/domain/marketData';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import type { AssetClass } from '../src/domain/constants';
import { estimateDailySigma } from '../src/domain/stability';
import {
  claimedProbability,
  disciplineFor,
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

const FROM = '2019-01-01';
const TO = '2021-12-31';
const HORIZON = 30; // 거래일
const CADENCE = 6; // 거래일마다 한 장 (자산군당 활성 5장 × 기한 30일)
/**
 * 신고 정책. **정직한 값을 데이터에서 찾아야 한다** — 처음에 c=5로 돌렸더니 모든
 * 구간에서 D가 내려갔는데, 그것은 국면 문제가 아니라 c=5가 p̂≈70%를 신고하는 값이라
 * 실제 도달률(20~35%)과 애초에 맞지 않았기 때문이다. 래더가 제 일을 한 것이지
 * 급변장 때문이 아니다. 여러 c로 훑어 정직한 자리를 찾고, **그 자리에서 국면 간
 * 차이**를 본다.
 */
let CONFIDENCE = 5;
const RUNG1 = evidenceThreshold(DISCIPLINE_ALPHA[0]); // −2.30

const UNIVERSE: Record<AssetClass, string[]> = {
  KR_EQUITY: ['005930', '000660', '035420', '051910', '005380', '068270'],
  US_EQUITY: ['AAPL', 'MSFT', 'JPM', 'XOM', 'NVDA', 'DIS'],
  CRYPTO: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
};

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
 * (infra/marketData/kisProvider.pagedDaily), 3년을 한 번에 달라고 하면 **최근 300건만**
 * 온다 — 실측으로 2020-10 이후만 왔다. 프로덕션은 120거래일 창만 쓰므로 그 상한이
 * 맞는 값이다. 그래서 공급자를 고치지 않고 여기서 구간을 쪼갠다.
 * (업비트는 자르지 않지만 초당 요청 제한이 있어 사이를 띄운다)
 */
async function loadBars(): Promise<Map<string, { assetClass: AssetClass; bars: Bar[] }>> {
  const registry = createDefaultRegistry();
  const out = new Map<string, { assetClass: AssetClass; bars: Bar[] }>();
  const years = [2019, 2020, 2021];
  for (const [assetClass, tickers] of Object.entries(UNIVERSE) as [AssetClass, string[]][]) {
    const provider = resolveProvider(registry, assetClass);
    for (const ticker of tickers) {
      try {
        const merged = new Map<string, Bar>();
        for (const y of years) {
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
          if (assetClass === 'CRYPTO') await sleep(400); // 429 방지
        }
        const q = [...merged.values()];
        const bars = q
          .filter((b) => b.close > 0 && b.high > 0 && b.low > 0)
          .sort((a, b) => a.date.localeCompare(b.date));
        // 폭락 구간(2020-02~04)이 실제로 들어 있는지 확인한다 — 없으면 이 종목은 쓸모없다
        const inCrash = bars.filter((b) => b.date >= '2020-02-15' && b.date <= '2020-04-15').length;
        if (bars.length < 500 || inCrash < 20) {
          console.log(`\n  · ${ticker}: ${bars.length}건 / 폭락 구간 ${inCrash}건 — 건너뜀`);
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
  key: string;
  assetClass: AssetClass;
  openIdx: number;
  openDate: string;
  closeDate: string;
  /** 게시 시점에 잰 σ (production과 같은 추정기) */
  sigma: number;
  magnitudePct: number;
  p0: number;
  pHat: number;
  hit: boolean;
  info: number;
}

/** 한 종목에서 낼 수 있는 카드를 전부 만든다 — 실제 종가로 판정까지 */
function buildCards(key: string, assetClass: AssetClass, bars: Bar[]): Card[] {
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

    const base = bars[i].close;
    const target = base * (1 + magnitudePct / 100);
    let hit = false;
    for (let j = i + 1; j <= i + HORIZON; j++) {
      if (bars[j].close >= target) {
        hit = true;
        break;
      }
    }
    cards.push({
      key,
      assetClass,
      openIdx: i,
      openDate: bars[i].date,
      closeDate: bars[Math.min(i + HORIZON, bars.length - 1)].date,
      sigma,
      magnitudePct,
      p0,
      pHat,
      hit,
      info: hit ? Math.log(pHat / p0) : Math.log((1 - pHat) / (1 - p0)),
    });
  }
  return cards;
}

const month = (d: string) => d.slice(0, 7);

async function main() {
  console.log(`\n■ 급변장에서 래더가 어떻게 되나 — 실제 일봉 ${FROM} ~ ${TO}`);
  console.log(`  정책: 상승 · 크기 = 하한(1.2·σ·√30) · 신뢰도 ${CONFIDENCE} · ${CADENCE}거래일마다 1장`);
  console.log(`  σ는 production과 같은 추정기(종가 120일 + Parkinson 10일)로 게시 시점에 고정\n`);
  process.stdout.write('  시세 받는 중 ');
  const data = await loadBars();
  console.log(`  종목 ${data.size}개\n`);

  const build = () => {
    const out: Card[] = [];
    for (const [key, { assetClass, bars }] of data) out.push(...buildCards(key, assetClass, bars));
    return out.sort((a, b) => a.openDate.localeCompare(b.openDate));
  };
  const all = build();
  console.log(`  카드 ${all.length}장 생성\n`);

  // ── ⓪ 정직한 신뢰도는 어디인가 ────────────────────────────
  // 국면을 논하기 전에 "이 정책이 애초에 정직한가"부터 정해야 한다.
  const PERIODS: [string, string, string][] = [
    ['평상(2019)', '2019-01-01', '2019-12-31'],
    ['폭락 직전', '2020-01-01', '2020-02-14'],
    ['**폭락**', '2020-02-15', '2020-04-15'],
    ['반등', '2020-04-16', '2020-12-31'],
    ['평상(2021)', '2021-01-01', '2021-12-31'],
  ];
  console.log('■ ⓪ 신뢰도별 카드당 정보량 — 0에 가까운 곳이 정직한 자리다');
  console.log(`  ${'구간'.padEnd(12)}${'카드'.padStart(6)}${'모델 p₀'.padStart(9)}${'실제'.padStart(8)}` +
    [2, 3, 4, 5].map((c) => `c=${c}`.padStart(9)).join(''));
  for (const [label, from, to] of PERIODS) {
    const idx = all.filter((c) => c.openDate >= from && c.openDate <= to);
    if (idx.length === 0) continue;
    const p0 = idx.reduce((a, c) => a + c.p0, 0) / idx.length;
    const real = idx.filter((c) => c.hit).length / idx.length;
    const cells = [2, 3, 4, 5].map((cc) => {
      const info =
        idx.reduce((a, c) => {
          const ph = claimedProbability(c.p0, cc);
          return a + (c.hit ? Math.log(ph / c.p0) : Math.log((1 - ph) / (1 - c.p0)));
        }, 0) / idx.length;
      return info.toFixed(3).padStart(9);
    });
    console.log(
      `  ${label.padEnd(12)}${String(idx.length).padStart(6)}${((p0 * 100).toFixed(1) + '%').padStart(9)}` +
        `${((real * 100).toFixed(1) + '%').padStart(8)}${cells.join('')}`,
    );
  }
  console.log('');

  CONFIDENCE = 2; // ⓪이 가리키는 정직한 자리 — 아래는 전부 이 값으로 다시 만든다
  const honest = build();

  // ── ① 모델 p₀ vs 실제 도달률 (월별) ────────────────────────
  console.log(`■ ① 모델이 말한 p₀ vs 실제 도달률 — 상승 카드 (정직한 신뢰도 c=${CONFIDENCE})`);
  console.log(`  ${'월'.padEnd(9)}${'카드'.padStart(6)}${'모델 p₀'.padStart(9)}${'실제'.padStart(8)}${'차이'.padStart(9)}${'카드당 정보량'.padStart(14)}`);
  const byMonth = new Map<string, Card[]>();
  for (const c of honest) {
    const m = month(c.openDate);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m)!.push(c);
  }
  const months = [...byMonth.keys()].sort();
  const rows: { m: string; gap: number; info: number; n: number }[] = [];
  for (const m of months) {
    const g = byMonth.get(m)!;
    const p0 = g.reduce((a, c) => a + c.p0, 0) / g.length;
    const real = g.filter((c) => c.hit).length / g.length;
    const info = g.reduce((a, c) => a + c.info, 0) / g.length;
    rows.push({ m, gap: real - p0, info, n: g.length });
  }
  // 전부 찍으면 36줄이라 최악 6개월 + 최선 3개월만 본다
  const worst = [...rows].sort((a, b) => a.info - b.info).slice(0, 6);
  const best = [...rows].sort((a, b) => b.info - a.info).slice(0, 3);
  const show = (r: (typeof rows)[number]) => {
    const g = byMonth.get(r.m)!;
    const p0 = g.reduce((a, c) => a + c.p0, 0) / g.length;
    const real = g.filter((c) => c.hit).length / g.length;
    console.log(
      `  ${r.m.padEnd(9)}${String(r.n).padStart(6)}${((p0 * 100).toFixed(1) + '%').padStart(9)}` +
        `${((real * 100).toFixed(1) + '%').padStart(8)}` +
        `${((r.gap >= 0 ? '+' : '') + (r.gap * 100).toFixed(1) + '%p').padStart(9)}` +
        `${r.info.toFixed(3).padStart(14)}`,
    );
  };
  console.log('  ── 정보량이 가장 나쁜 6개월 ──');
  for (const r of worst.sort((a, b) => a.m.localeCompare(b.m))) show(r);
  console.log('  ── 가장 좋은 3개월 ──');
  for (const r of best.sort((a, b) => a.m.localeCompare(b.m))) show(r);

  // ── ② 리서처의 D가 어디까지 내려가나 ──────────────────────
  // 리서처 한 명 = 자산군 하나에서 그 자산군 종목들에 순서대로 카드를 낸다.
  // 상관 보정을 그대로 적용하고, 증거는 리셋하지 않는다(현행).
  console.log('\n■ ② 리서처의 증거 D — 자산군별, 상관 보정 적용, 리셋 없음');
  console.log(`  문턱 −2.30(1단) · 카드는 실제 판정 결과로 채점 · **정직한 신뢰도 c=${CONFIDENCE}**\n`);
  console.log(
    `  ${'자산군'.padEnd(11)}${'카드'.padStart(6)}${'최저 D'.padStart(9)}  ${'최저 시점'.padStart(10)}  ${'1단 도달'.padStart(10)}  ${'2단 도달'.padStart(10)}`,
  );
  for (const assetClass of Object.keys(UNIVERSE) as AssetClass[]) {
    const cards = honest.filter((c) => c.assetClass === assetClass);
    if (cards.length === 0) continue;
    const judged: EvidenceCard[] = [];
    let minD = 0;
    let minAt = '';
    let hit1 = '';
    let hit2 = '';
    // 판정 순서(마감일)로 훑는다
    const byClose = [...cards].sort((a, b) => a.closeDate.localeCompare(b.closeDate));
    const DAY = 86_400_000;
    for (const c of byClose) {
      judged.push({
        assetClass,
        direction: 'UP',
        openedAt: Date.parse(c.openDate) / 1 || 0,
        closedAt: Date.parse(c.closeDate) / 1 || 0,
        info: c.info,
      });
      void DAY;
      const d = aggregateEvidence(judged)[assetClass];
      if (d < minD) {
        minD = d;
        minAt = c.closeDate;
      }
      if (!hit1 && d <= RUNG1) hit1 = c.closeDate;
      if (!hit2 && d <= evidenceThreshold(DISCIPLINE_ALPHA[1])) hit2 = c.closeDate;
    }
    console.log(
      `  ${assetClass.padEnd(11)}${String(cards.length).padStart(6)}${minD.toFixed(2).padStart(9)}` +
        `  ${(minAt || '—').padStart(10)}  ${(hit1 || '—').padStart(10)}  ${(hit2 || '—').padStart(10)}`,
    );
  }

  // ── ③ 폭락 구간만 따로 ────────────────────────────────────
  console.log(`\n■ ③ 구간별 — 정직한 신뢰도 c=${CONFIDENCE} 기준`);
  console.log(
    `  ${'구간'.padEnd(12)}${'카드'.padStart(6)}${'모델 p₀'.padStart(9)}${'실제'.padStart(8)}${'카드당 정보량'.padStart(14)}${'σ 배수'.padStart(9)}`,
  );
  const baseSigma =
    honest.filter((c) => c.openDate < '2020-01-01').reduce((a, c) => a + c.sigma, 0) /
    Math.max(1, honest.filter((c) => c.openDate < '2020-01-01').length);
  for (const [label, from, to] of PERIODS) {
    const g = honest.filter((c) => c.openDate >= from && c.openDate <= to);
    if (g.length === 0) continue;
    const p0 = g.reduce((a, c) => a + c.p0, 0) / g.length;
    const real = g.filter((c) => c.hit).length / g.length;
    const info = g.reduce((a, c) => a + c.info, 0) / g.length;
    const sig = g.reduce((a, c) => a + c.sigma, 0) / g.length;
    console.log(
      `  ${label.padEnd(12)}${String(g.length).padStart(6)}${((p0 * 100).toFixed(1) + '%').padStart(9)}` +
        `${((real * 100).toFixed(1) + '%').padStart(8)}${info.toFixed(3).padStart(14)}` +
        `${(sig / baseSigma).toFixed(2) + '배'}`.padStart(9),
    );
  }
  console.log('');
}

main();
