// 코인 전 종목(업비트 KRW 마켓) 히트맵 스냅샷 생성 — 국내·미국주식과 같은 형식.
// 소스 (무인증 공개 API, 1회 스냅샷 — 실시간 연동 아님):
//  - 업비트 market/all: KRW 마켓 거래 가능 코인 목록(마켓코드·한글명) ← 유니버스 기준
//  - CoinGecko coins/markets(vs_currency=krw): 시가총액 → 조 원 환산
// 코인은 산업 섹터가 없어 성격별 카테고리(결제·스마트 컨트랙트·밈·디파이 …)로 묶는다.
// CoinGecko에 매칭 안 되는 소형 코인은 0.01조로 두어 목록에는 남긴다(화면에선 생략될 수 있음).
// 출력: src/data/crypto-heatmap.json
// 실행: node scripts/buildCryptoHeatmap.mjs   (분기 1회 재실행이면 충분)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "crypto-heatmap.json");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

// 심볼 → 카테고리 (업비트 상장 코인 기준 수동 분류, 나머지는 기타 알트코인)
const SECTOR_RULES = [
  [["BTC", "BCH", "LTC", "BSV"], "가치 저장·결제"],
  [["XRP", "XLM"], "결제·송금"],
  [
    ["ETH", "SOL", "ADA", "AVAX", "TRX", "ATOM", "NEAR", "DOT", "SUI", "APT", "SEI",
     "ALGO", "ETC", "HBAR", "VET", "KAIA", "ICX", "QTUM", "NEO", "EGLD", "TON", "CELO"],
    "스마트 컨트랙트",
  ],
  [["ARB", "OP", "STRK", "POL", "MATIC", "ZK", "BLAST", "MNT"], "레이어2·확장"],
  [["USDT", "USDC"], "스테이블코인"],
  [["DOGE", "SHIB", "PEPE", "BONK", "WIF", "MEW", "TRUMP", "PENGU"], "밈"],
  [["UNI", "AAVE", "COMP", "CRV", "SUSHI", "1INCH", "INJ", "JUP", "ONDO", "ENA"], "디파이"],
  [["LINK", "PYTH", "GRT", "FIL", "AR", "STORJ", "THETA", "ANKR"], "인프라·오라클"],
  [["FET", "RENDER", "RNDR", "TAO", "VIRTUAL", "AKT"], "AI"],
  [["SAND", "MANA", "AXS", "IMX", "ENJ", "GMT", "PLA", "BORA"], "게임·메타버스"],
];

function toSector(symbol) {
  for (const [symbols, sector] of SECTOR_RULES) if (symbols.includes(symbol)) return sector;
  return "기타 알트코인";
}

// ── 1. 업비트 KRW 마켓 목록 ──
const marketsRes = await fetch("https://api.upbit.com/v1/market/all", { headers: UA });
if (!marketsRes.ok) throw new Error(`업비트 HTTP ${marketsRes.status}`);
const markets = (await marketsRes.json()).filter((m) => m.market.startsWith("KRW-"));
console.log(`업비트 KRW 마켓: ${markets.length}종목`);

// ── 2. CoinGecko 시가총액 (상위 750, KRW) ──
const caps = new Map(); // SYMBOL → cap(KRW) — 내림차순 순회라 첫 값(최대)만 유지
for (let page = 1; page <= 3; page++) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=krw&order=market_cap_desc&per_page=250&page=${page}`,
    { headers: UA },
  );
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status} (page ${page})`);
  for (const coin of await res.json()) {
    const sym = (coin.symbol ?? "").toUpperCase();
    if (sym && coin.market_cap > 0 && !caps.has(sym)) caps.set(sym, coin.market_cap);
  }
  await new Promise((r) => setTimeout(r, 1200)); // 무인증 레이트리밋 배려
}
console.log(`CoinGecko 시총: ${caps.size}종목`);

let unmatched = 0;
const stocks = markets
  .map((m) => {
    const symbol = m.market.slice(4);
    const capKrw = caps.get(symbol);
    if (!capKrw) unmatched++;
    return {
      code: m.market, // 업비트 마켓코드 (KRW-BTC) — 예측 카드 티커와 동일 체계
      name: m.korean_name,
      sector: toSector(symbol),
      capT: capKrw ? Math.round((capKrw / 1e12) * 1000) / 1000 : 0.01,
    };
  })
  .sort((a, b) => b.capT - a.capT);

writeFileSync(
  OUT,
  JSON.stringify(
    { snapshotDate: new Date().toISOString().slice(0, 10), count: stocks.length, stocks },
    null,
    1,
  ),
  "utf8",
);

const bySector = {};
for (const s of stocks) bySector[s.sector] = (bySector[s.sector] ?? 0) + 1;
console.log(`저장: ${OUT} (${stocks.length}종목, 시총 미매칭 ${unmatched})`);
console.log("섹터 분포:", JSON.stringify(bySector));
console.log("상위 5:", stocks.slice(0, 5).map((s) => `${s.name} ${s.capT}조 [${s.sector}]`).join(" / "));
