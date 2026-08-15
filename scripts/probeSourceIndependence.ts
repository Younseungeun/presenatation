import { createDefaultRegistry, createSecondaryRegistry } from '../src/infra/marketData/registry';
import { maxCloseDeviation } from '../src/domain/crossCheck';
import type { AssetClass } from '../src/domain/constants';
import type { DailyQuote, MarketDataProvider } from '../src/domain/marketData';

// **두 시세 소스가 정말 독립인가** — `npm run probe:sources` (2026-08-15, 외부 검토 D-2).
//
// ── 왜 이걸 재야 하는가 ─────────────────────────────────────────────
// 교차검증은 "두 번째 증인"을 전제한다. 그런데 두 소스가 **같은 원천에서 갈라져 나온
// 중계선**이면(둘 다 KRX 체결가를 받아 전달) 증인이 하나인데 둘인 척하는 것이다.
// 그 상태에서는 **불일치 0건이 안전의 증거가 아니라 대조가 무의미하다는 증거**인데,
// 결과만 봐서는 두 경우가 완전히 똑같이 생겼다.
//
// ── 어떻게 가르는가 (검토가 제안한 방법) ────────────────────────────
// **가격이 아니라 거래량을 본다.** 가격은 같은 체결에서 나오므로 원천이 달라도 같은
// 값이 나올 수 있지만, 거래량·집계 경계는 취합망을 지나며 미세하게 갈라진다:
//  · 같은 원천을 중계만 했다면 → 거래량이 **주 단위까지 정확히 일치**한다
//  · 다른 경로로 집계했다면 → 값은 비슷해도 델타가 남는다 (체결 분류·시간외 포함 여부)
//
// 그래서 판정 기준은 이렇다:
//   거래량 완전 일치율이 높다  → **같은 원천.** 교차검증이 자기 확인이라 값어치가 없다
//   거래량에 델타가 있다        → 독립. 종가가 같은 것은 시장이 하나라 그런 것이다
//
// 결과를 어디에 쓰나: ① 새 소스를 계약하기 **전에** 이 검사를 돌려 "대조가 성립하는
// 조합인지" 확인한다 ② 이미 붙인 소스가 뒤늦게 같은 원천으로 바뀌는 것(공급자 백엔드
// 교체)을 잡는다.

const DAYS = 30;
const SAMPLE: Partial<Record<AssetClass, string[]>> = {
  CRYPTO: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE'],
  KR_EQUITY: ['005930', '000660', '035420'],
  US_EQUITY: ['AAPL', 'MSFT', 'NVDA'],
};

/** 거래량이 **주/개 단위까지** 같은가 — 부동소수 표기 차이만 흡수한다 */
function sameVolume(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return false;
  return Math.abs(a - b) < Math.max(1e-8, Math.abs(a) * 1e-9);
}

interface Verdict {
  ticker: string;
  overlapDays: number;
  volumeExactRatio: number;
  closeExactRatio: number;
  maxCloseDev: number | null;
}

async function probe(
  primary: MarketDataProvider,
  secondary: MarketDataProvider,
  ticker: string,
  from: string,
  to: string,
): Promise<Verdict | { ticker: string; error: string }> {
  let a: DailyQuote[];
  let b: DailyQuote[];
  try {
    [a, b] = await Promise.all([
      primary.getDailyQuotes(ticker, from, to),
      secondary.getDailyQuotes(ticker, from, to),
    ]);
  } catch (e) {
    return { ticker, error: e instanceof Error ? e.message : String(e) };
  }

  const byDate = new Map(b.map((q) => [q.date, q]));
  const pairs = a.flatMap((q) => {
    const other = byDate.get(q.date);
    return other ? [[q, other] as const] : [];
  });
  if (pairs.length === 0) return { ticker, error: '겹치는 거래일이 없습니다' };

  return {
    ticker,
    overlapDays: pairs.length,
    volumeExactRatio: pairs.filter(([x, y]) => sameVolume(x.volume, y.volume)).length / pairs.length,
    closeExactRatio: pairs.filter(([x, y]) => x.close === y.close).length / pairs.length,
    maxCloseDev: maxCloseDeviation(
      pairs.map(([x]) => x),
      pairs.map(([, y]) => y),
    ),
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

async function main(): Promise<void> {
  const primary = createDefaultRegistry();
  const secondary = createSecondaryRegistry();
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

  console.log(`\n소스 독립성 검사 — ${from} ~ ${to}\n`);

  for (const [assetClass, tickers] of Object.entries(SAMPLE) as [AssetClass, string[]][]) {
    const p = primary[assetClass];
    const s = secondary[assetClass];
    console.log('─'.repeat(72));
    if (!p) {
      console.log(`${assetClass}: 주 소스 미등록 — 건너뜁니다`);
      continue;
    }
    if (!s) {
      console.log(`${assetClass}: 두 번째 소스 없음 (${p.sourceId} 단독 판정)`);
      continue;
    }
    console.log(`${assetClass}: ${p.sourceId} ↔ ${s.sourceId}`);

    const results = [];
    for (const t of tickers) {
      const r = await probe(p, s, t, from, to);
      if ('error' in r) {
        console.log(`  ${t.padEnd(10)} 조회 실패 — ${r.error}`);
        continue;
      }
      results.push(r);
      console.log(
        `  ${r.ticker.padEnd(10)} 겹친 거래일 ${String(r.overlapDays).padStart(3)}일 · ` +
          `거래량 완전일치 ${pct(r.volumeExactRatio).padStart(4)} · ` +
          `종가 완전일치 ${pct(r.closeExactRatio).padStart(4)} · ` +
          `종가 최대괴리 ${r.maxCloseDev === null ? '—' : `${(r.maxCloseDev * 100).toFixed(2)}%`}`,
      );
    }

    if (results.length === 0) {
      console.log('  → 판단 불가 (표본 없음)');
      continue;
    }
    const vol = results.reduce((acc, r) => acc + r.volumeExactRatio, 0) / results.length;
    // 문턱을 0.9로 둔 이유: 완전 중계라면 거의 100%가 나오고, 다른 경로라면 우연히
    // 겹치는 날(거래량이 작은 종목)이 있어도 이만큼 올라오지 않는다
    if (vol >= 0.9) {
      console.log(
        `  ⚠ 거래량 완전일치 평균 ${pct(vol)} — **같은 원천으로 보입니다.**\n` +
          `     이 조합의 교차검증은 자기 확인이라 통과해도 아무것도 보증하지 않습니다.\n` +
          `     다른 취합망을 쓰는 소스로 바꾸거나, 이 자산군은 단독 판정으로 두십시오.`,
      );
    } else {
      console.log(
        `  ✓ 거래량 완전일치 평균 ${pct(vol)} — 서로 다른 경로로 집계된 것으로 보입니다.\n` +
          `     종가가 비슷한 것은 시장이 하나라서이지 소스가 하나라서가 아닙니다.`,
      );
    }
  }
  console.log('─'.repeat(72));
  console.log(
    '\n※ 이 검사는 **계약 전에** 돌리는 것이 핵심입니다 — 붙이고 나서 같은 원천이었음을\n' +
      '  알게 되면 이미 그 소스로 판정이 나간 뒤입니다.\n',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
