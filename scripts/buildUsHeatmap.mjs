// 미국주식 전 종목(S&P 500) 히트맵 스냅샷 생성 — 국내주식(kospi-heatmap)과 같은 형식.
// 소스 (무인증 공개 페이지, 1회 스냅샷 — 실시간 연동 아님):
//  - 위키피디아 "List of S&P 500 companies": 티커·회사명·GICS 섹터
//  - stockanalysis.com S&P 500 목록: 시가총액(USD, 5.00T/850B 형식)
//    → 1,400원/달러로 조 원 환산 (Slickcharts는 봇 차단이라 차선 소스)
// GICS 11개 섹터는 국내 히트맵과 같은 한국어 섹터명으로 매핑한다.
// 출력: src/data/us-heatmap.json
// 실행: node scripts/buildUsHeatmap.mjs   (분기 1회 재실행이면 충분)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "us-heatmap.json");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const KRW_PER_USD = 1400; // 환산 환율 (표시용 대략값)

const GICS_TO_KO = {
  "Information Technology": "전자 기술",
  "Communication Services": "커뮤니케이션",
  "Health Care": "의료 기술",
  Financials: "금융",
  "Consumer Discretionary": "소비자 내구재",
  "Consumer Staples": "소비재 비내구재",
  Industrials: "생산자 제조",
  Energy: "에너지 미네랄",
  Materials: "공정 산업",
  Utilities: "유틸리티",
  "Real Estate": "부동산",
};

const strip = (s) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();

// ── 1. 위키피디아: 티커 → {name, sector} ──
async function fetchWikipedia() {
  const res = await fetch("https://en.wikipedia.org/wiki/List_of_S%26P_500_companies", {
    headers: UA,
  });
  if (!res.ok) throw new Error(`Wikipedia HTTP ${res.status}`);
  const html = await res.text();
  const table = html.split('id="constituents"')[1]?.split("</table>")[0];
  if (!table) throw new Error("위키피디아 constituents 표를 찾지 못했습니다");
  const map = {};
  for (const row of table.split(/<tr[^>]*>/).slice(2)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => strip(m[1]));
    if (cells.length < 3) continue;
    const ticker = cells[0].replace(/\./g, "."); // BRK.B 형태 유지
    if (!/^[A-Z][A-Z.]{0,6}$/.test(ticker)) continue;
    map[ticker] = { name: cells[1], sector: GICS_TO_KO[cells[2]] ?? "기타" };
  }
  return map;
}

// ── 2. stockanalysis.com: 티커 → 시가총액(USD) ──
// 행 마크업: <a href="/stocks/nvda/">NVDA</a> … <td …>5.00T</td> (T=조 달러, B=십억 달러)
async function fetchCaps() {
  const res = await fetch("https://stockanalysis.com/list/sp-500-stocks/", { headers: UA });
  if (!res.ok) throw new Error(`stockanalysis HTTP ${res.status}`);
  const html = await res.text();
  const caps = {};
  for (const row of html.split(/<tr[^>]*>/).slice(1)) {
    const sym = row.match(/href="\/stocks\/[a-z.-]+\/">([A-Z.]{1,7})</);
    const cap = row.match(/>([\d.]+)([TB])</);
    if (!sym || !cap) continue;
    const usdBillion = parseFloat(cap[1]) * (cap[2] === "T" ? 1000 : 1);
    // 조 원 = 십억 달러 × 환율 / 1000 (10억 달러 = 1.4조 원)
    caps[sym[1]] = (usdBillion * KRW_PER_USD) / 1000;
  }
  return caps;
}

const [wiki, caps] = await Promise.all([fetchWikipedia(), fetchCaps()]);
console.log(`위키피디아: ${Object.keys(wiki).length}종목, stockanalysis 시총: ${Object.keys(caps).length}종목`);

// 종류주(Alphabet Class A/C 등)는 회사 시총이 클래스마다 중복 계상되므로 회사 단위로
// 하나만 남긴다 (코스피의 우선주와 달리 클래스별 시총 분리값을 소스가 주지 않아서)
const byCompany = new Map();
for (const [code, { name, sector }] of Object.entries(wiki)) {
  const capT = caps[code] ?? caps[code.replace(".", "-")];
  if (!capT) continue;
  const company = name.replace(/\s*\(Class [A-C]\)/i, "").trim();
  const prev = byCompany.get(company);
  if (!prev || capT > prev.capT) {
    byCompany.set(company, { code, name: company, sector, capT: Math.round(capT * 100) / 100 });
  }
}
const stocks = [...byCompany.values()]
  .filter((s) => s.capT > 0)
  .sort((a, b) => b.capT - a.capT);

if (stocks.length < 300) throw new Error(`${stocks.length}종목만 결합 — 소스 형식 변경 가능`);

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
console.log(`저장: ${OUT} (${stocks.length}종목)`);
console.log("섹터 분포:", JSON.stringify(bySector));
console.log("상위 5:", stocks.slice(0, 5).map((s) => `${s.name} ${s.capT}조 [${s.sector}]`).join(" / "));
