// 코스피 전 종목 히트맵 스냅샷 생성 — 히트맵 규칙 3(코스피 전 종목)·2(면적 ∝ 시총)용.
// 소스 (모두 무인증 공개 페이지, 1회 스냅샷 — 실시간 연동 아님):
//  - 네이버 금융 시가총액 목록(코스피): 종목코드·종목명·시가총액
//    (KRX 정보데이터시스템은 로그인제 전환, 금융위 API는 키 미발급이라 차선 소스)
//  - KIND 상장법인 목록: 종목코드 → 업종(한국표준산업분류)
// 업종은 수백 종으로 잘게 나뉘어 트레이딩뷰풍 대형 섹터로 키워드 매핑한다 (규칙 4).
// 출력: src/data/kospi-heatmap.json
// 실행: node scripts/buildKospiHeatmap.mjs   (분기 1회 재실행이면 충분)
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "data", "kospi-heatmap.json");

// ── 1. 네이버 금융 시가총액 목록 (코스피 sosok=0) — 페이지가 빌 때까지 순회 ──
// 표 컬럼: N | 종목명 | 현재가 | 전일비 | 등락률 | 액면가 | 시가총액(억) | 상장주식수 | …
async function fetchNaverPage(page) {
  const res = await fetch(
    `https://finance.naver.com/sise/sise_market_sum.naver?sosok=0&page=${page}`,
    { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } },
  );
  if (!res.ok) throw new Error(`네이버 금융 HTTP ${res.status} (page ${page})`);
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
  const out = [];
  // 행 단위: 종목 링크(code)와 그 행의 td들
  for (const row of html.split(/<tr[^>]*>/).slice(1)) {
    // 계열 우선주(현대차3우B 등)는 코드 끝자리가 영문자라 [0-9A-Z] 허용
    const link = row.match(/\/item\/main\.naver\?code=([0-9A-Z]{6})"[^>]*>([^<]+)</);
    if (!link) continue;
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
      m[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim(),
    );
    // 시가총액(억 원) = 7번째 컬럼 — 숫자만 있는 td 중 위치로 찾기보다 인덱스 고정이 안전
    const capEok = Number((tds[6] ?? "").replaceAll(",", ""));
    if (!Number.isFinite(capEok) || capEok <= 0) continue;
    out.push({ code: link[1], name: link[2].trim(), capEok });
  }
  return out;
}

async function fetchKospiCaps() {
  const all = new Map();
  for (let page = 1; page <= 60; page++) {
    const rows = await fetchNaverPage(page);
    if (rows.length === 0) break;
    for (const r of rows) all.set(r.code, r);
    await new Promise((r) => setTimeout(r, 150)); // 예의상 간격
  }
  if (all.size < 500) throw new Error(`코스피 ${all.size}종목만 수집 — 페이지 형식 변경 가능`);
  return [...all.values()];
}

// ── 2. KIND 상장법인 목록 — 종목코드 → 업종 ──
async function fetchIndustries() {
  const res = await fetch(
    "https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&searchType=13",
    { headers: { "User-Agent": "Mozilla/5.0" } },
  );
  if (!res.ok) throw new Error(`KIND HTTP ${res.status}`);
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());
  const rows = html.split(/<tr[\s>]/i).slice(1);
  const strip = (s) => s.replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim();
  const map = {};
  for (const row of rows) {
    const tds = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => strip(m[1]));
    if (tds.length < 4) continue;
    const code = tds.find((t) => /^\d{6}$/.test(t));
    if (code) map[code] = tds[3] || ""; // 회사명|시장구분|종목코드|업종|…
  }
  return map;
}

// ── 3. 업종(세분류) → 트레이딩뷰풍 대형 섹터 (순서 중요 — 먼저 걸리는 규칙 우선).
// KIND 업종 실측 표기 기준: "전기 통신업"이 "전기업"보다 먼저 걸려야 해서 커뮤니케이션이
// 유틸리티보다 앞이고, "석유 정제품"은 에너지 미네랄로 분리한다 ──
const SECTOR_RULES = [
  [/반도체|전자부품|통신.*장비|영상|음향|컴퓨터|디스플레이|인쇄회로|사무용.*기기|측정|광학|시계|항공기|우주|무기|방산/, "전자 기술"],
  [/은행|보험|금융|증권|투자|여신|신탁|연금|카드/, "금융"],
  [/의약|제약|바이오|의료|생물/, "의료 기술"],
  [/소프트웨어|정보.*서비스|게임|포털|프로그래밍|자료.*처리|인터넷/, "기술 서비스"],
  [/자동차|이륜|가전|가구/, "소비자 내구재"],
  [/전기.?통신|방송|통신업/, "커뮤니케이션"],
  [/석유|정유|연료|원유/, "에너지 미네랄"],
  [/전기업|가스|발전|수도|증기/, "유틸리티"],
  [/화학|고무|플라스틱|섬유|의복|제지|펄프|비료|페인트|화장품/, "공정 산업"],
  [/금속|철강|광업|시멘트|유리|요업|비금속|알루미|제련/, "비에너지 광물"],
  [/기계|장비|조선|선박|전지|엔진|공구|중공업|플랜트/, "생산자 제조"],
  [/건설|토목|엔지니어링|부동산/, "산업 서비스"],
  [/운송|해상|물류|창고|택배|철도|항공/, "이송/배달"],
  [/도매|소매|유통|백화점|상품.*중개|무역/, "소매업"],
  [/음.식료|식품|음료|담배|수산|농업|축산/, "소비재 비내구재"],
  [/숙박|음식점|여행|오락|영화|공연|교육|스포츠/, "컨슈머 서비스"],
];

function toSector(industry) {
  for (const [re, sector] of SECTOR_RULES) if (re.test(industry)) return sector;
  return "기타";
}

const rows = await fetchKospiCaps();
console.log(`네이버 금융 코스피 목록: ${rows.length}행 (ETF·ETN 포함)`);
const industries = await fetchIndustries();
console.log(`KIND 업종: ${Object.keys(industries).length}개사`);

// 주식 종목 판별: KIND 상장법인 목록에 본 종목 또는 모회사 코드(우선주 → 끝자리 0)가
// 있는 것만 남긴다 — ETF·ETN은 법인이 아니라 KIND에 없으므로 자연히 걸러진다 (규칙 3의
// "주식 종목"에 해당하는 것만). 우선주 업종은 모회사 업종을 따른다.
const baseCode = (code) => code.slice(0, 5) + "0";
const stocks = rows
  .map((r) => {
    const industry = industries[r.code] ?? industries[baseCode(r.code)];
    if (industry === undefined) return null; // ETF·ETN·비법인 상품
    return {
      code: r.code,
      name: r.name,
      sector: toSector(industry),
      /** 조 원 단위 (네이버는 억 원) */
      capT: Math.round((r.capEok / 10_000) * 1000) / 1000,
    };
  })
  .filter((s) => s !== null && s.capT > 0)
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
console.log(`저장: ${OUT} (${stocks.length}종목)`);
console.log("섹터 분포:", JSON.stringify(bySector));
console.log("상위 5:", stocks.slice(0, 5).map((s) => `${s.name} ${s.capT}조 [${s.sector}]`).join(" / "));
