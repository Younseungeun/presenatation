export {};

// 업비트 KRW 마켓 전 종목의 실현 변동성 분포 (공개 API, 키 불필요).
//
// 왜 재나: `UNMEASURED_SIGMA`(σ를 못 잰 종목의 폴백)를 자산군마다 "실측 분포의 상위
// 5분위 경계"로 두기로 했는데, 주식은 그 값이 이미 있고(STABILITY_SIGMA_BOUNDS,
// calibrateStability 300종목) **코인은 없었다.** 없는 값을 주식 배수로 외삽했더니
// 14%/일이 나왔는데, 실측 최대가 11.1%라 **관측된 적 없는 값**이었다.
//
//   npm run measure:cryptosigma

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BARS = 121; // 로그수익률 120개

type Row = { market: string; sigma: number; n: number };

const markets: { market: string }[] = await (await fetch('https://api.upbit.com/v1/market/all')).json();
const krw = markets.filter((m) => m.market.startsWith('KRW-'));
console.log(`KRW 마켓 ${krw.length}종목 — 일봉 ${BARS}개씩 조회합니다`);

const rows: Row[] = [];
for (const m of krw) {
  try {
    const r = await fetch(`https://api.upbit.com/v1/candles/days?market=${m.market}&count=${BARS}`);
    if (r.ok) {
      const candles: { trade_price: number }[] = await r.json();
      const closes = candles.map((c) => c.trade_price).reverse();
      const rets: number[] = [];
      for (let i = 1; i < closes.length; i++) {
        if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
      }
      if (rets.length >= 20) {
        const mu = rets.reduce((a, b) => a + b, 0) / rets.length;
        const v = rets.reduce((a, b) => a + (b - mu) ** 2, 0) / (rets.length - 1);
        rows.push({ market: m.market, sigma: Math.sqrt(v), n: rets.length });
      }
    }
  } catch {
    // 한 종목 실패로 전체를 멈추지 않는다
  }
  await sleep(120); // 업비트 공개 API 예의상 간격
}

rows.sort((a, b) => a.sigma - b.sigma);
const q = (p: number) => rows[Math.floor((rows.length - 1) * p)].sigma;
const asPct = (x: number) => `${(x * 100).toFixed(2)}%`;
console.log(`\n표본 ${rows.length}종목 (20개 미만 수익률은 제외 — 신규 상장은 애초에 잴 수 없다)`);
console.log(`  p20 ${asPct(q(0.2))}  중앙값 ${asPct(q(0.5))}  **p80 ${asPct(q(0.8))}**  p90 ${asPct(q(0.9))}  최대 ${asPct(rows[rows.length - 1].sigma)}`);
console.log(`  가장 거친 5종목: ${rows.slice(-5).map((r) => `${r.market} ${asPct(r.sigma)}`).join(' · ')}`);
console.log(`\n→ UNMEASURED_SIGMA.CRYPTO 후보(상위 5분위 경계) = ${asPct(q(0.8))}`);
