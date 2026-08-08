import { ASSET_CLASSES, TIERS, type AssetClass, type Direction, type Tier } from './constants';

// 카드 검색어 파서.
//
// 한 줄에 두 가지를 섞어 쓴다:
//   · 자유 텍스트 → 리서처 이름 ("크립토애널리스트")
//   · 해시태그   → 조건 ("#국내주식 #상승 #안정성 3이상")
//
// 왜 해시태그인가: 구매 전 마스킹 때문에 **종목명으로는 검색할 수 없다**. 종목 칩으로
// 좁히면 "이 칩을 누르니 나온 카드 = 그 종목 예측"이 되어 마스킹이 통째로 뚫린다.
// 그래서 검색은 종목이 아니라 **예측의 성질**(자산군·방향·확신·조건)을 축으로 삼는다.
// 해시태그는 그 축들을 한 줄에 겹쳐 쓰기에 가장 짧은 문법이다.
//
// 파싱은 '#'로 자른다. 공백으로 자르면 "#안정성 3이상"처럼 사람이 자연스럽게 띄어 쓴
// 조건이 두 토막 난다. 태그 몸통 안의 공백은 지운 뒤 해석한다.

export interface CardQuery {
  /** 해시태그가 아닌 부분 — 리서처 이름 검색어 */
  text: string;
  assetClasses: AssetClass[];
  direction: Direction | null;
  /** 별점(0~5) 하한 — 카드에 뜨는 표기와 같은 축 */
  minProfitability: number | null;
  minStability: number | null;
  minConfidence: number | null;
  /** 선결제 0% — 틀리면 전액 환불 */
  refundOnly: boolean;
  maxPriceKrw: number | null;
  withinDays: number | null;
  minTier: Tier | null;
  /** 경력 인증 배지 보유 리서처만 */
  verifiedOnly: boolean;
  /** 아직 판정 이력이 없는 리서처만 — 신규를 일부러 찾아보는 길 */
  newcomerOnly: boolean;
  /** 해석하지 못한 태그 — 화면이 "이건 못 알아들었어요"라고 말할 수 있게 남긴다 */
  unknown: string[];
}

const EMPTY: CardQuery = {
  text: '',
  assetClasses: [],
  direction: null,
  minProfitability: null,
  minStability: null,
  minConfidence: null,
  refundOnly: false,
  maxPriceKrw: null,
  withinDays: null,
  minTier: null,
  verifiedOnly: false,
  newcomerOnly: false,
  unknown: [],
};

const ASSET_WORDS: Record<string, AssetClass> = {
  국내주식: 'KR_EQUITY',
  한국주식: 'KR_EQUITY',
  국내: 'KR_EQUITY',
  코스피: 'KR_EQUITY',
  미국주식: 'US_EQUITY',
  해외주식: 'US_EQUITY',
  미국: 'US_EQUITY',
  코인: 'CRYPTO',
  암호화폐: 'CRYPTO',
  가상자산: 'CRYPTO',
};

const DIRECTION_WORDS: Record<string, Direction> = {
  상승: 'UP',
  롱: 'UP',
  매수: 'UP',
  하락: 'DOWN',
  숏: 'DOWN',
  매도: 'DOWN',
};

const TIER_WORDS: Record<string, Tier> = {
  시니어: 'SILVER',
  마스터: 'GOLD',
  펠로우: 'PLATINUM',
  인투빌펠로우: 'CHALLENGER',
};

/** 별점 조건 — "안정성3이상" / "신뢰도4" / "수익성3점이상" */
const RATING_RE = /^(수익성|안정성|신뢰도)([0-5](?:\.[0-9])?)(점)?(이상)?$/;
/** 예산 — "1만원이하" / "5000원이하" */
const BUDGET_RE = /^([0-9]+)(만)?원?(이하|미만)$/;
/** 시한 — "7일내" / "일주일내" / "한달내" / "30일이내" */
const WITHIN_RE = /^([0-9]+)일(내|이내)$/;

/** 태그 몸통을 해석해 조건에 반영한다. 못 알아들으면 false */
function applyTag(q: CardQuery, raw: string): boolean {
  const t = raw.replace(/\s+/g, '');
  if (!t) return true; // "# " 같은 빈 태그는 조용히 무시

  const asset = ASSET_WORDS[t];
  if (asset) {
    if (!q.assetClasses.includes(asset)) q.assetClasses.push(asset);
    return true;
  }

  const dir = DIRECTION_WORDS[t];
  if (dir) {
    q.direction = dir;
    return true;
  }

  const rating = RATING_RE.exec(t);
  if (rating) {
    const value = Number(rating[2]);
    if (rating[1] === '수익성') q.minProfitability = value;
    else if (rating[1] === '안정성') q.minStability = value;
    else q.minConfidence = value;
    return true;
  }

  if (t === '무위험' || t === '전액환불' || t === '100환불' || t === '100퍼환불') {
    q.refundOnly = true;
    return true;
  }

  const budget = BUDGET_RE.exec(t);
  if (budget) {
    q.maxPriceKrw = Number(budget[1]) * (budget[2] ? 10_000 : 1);
    return true;
  }

  if (t === '일주일내' || t === '일주일이내') {
    q.withinDays = 7;
    return true;
  }
  if (t === '한달내' || t === '한달이내') {
    q.withinDays = 30;
    return true;
  }
  if (t === '오늘마감') {
    q.withinDays = 1;
    return true;
  }
  const within = WITHIN_RE.exec(t);
  if (within) {
    q.withinDays = Number(within[1]);
    return true;
  }

  // "시니어이상" / "마스터" 둘 다 같은 뜻으로 받는다 — 등급은 원래 서열이라 "이상"이 기본값
  const tierWord = t.replace(/이상$/, '');
  const tier = TIER_WORDS[tierWord];
  if (tier) {
    q.minTier = tier;
    return true;
  }

  if (t === '인증' || t === '경력인증') {
    q.verifiedOnly = true;
    return true;
  }

  if (t === '신규' || t === '판정전' || t === '신규리서처') {
    q.newcomerOnly = true;
    return true;
  }

  return false;
}

/**
 * 검색어 → 조건.
 * '#'로 자르므로 첫 조각(첫 '#' 이전)이 자유 텍스트가 된다.
 */
export function parseCardQuery(input: string): CardQuery {
  const q: CardQuery = { ...EMPTY, assetClasses: [], unknown: [] };
  if (!input.trim()) return q;

  const [free, ...tags] = input.split('#');
  q.text = free.trim();

  for (const tag of tags) {
    if (!applyTag(q, tag)) q.unknown.push(tag.trim());
  }
  return q;
}

/** 조건이 하나라도 있나 — 화면이 검색 모드로 넘어갈지 판단 */
export function hasCriteria(q: CardQuery): boolean {
  return (
    q.text.length > 0 ||
    q.assetClasses.length > 0 ||
    q.direction !== null ||
    q.minProfitability !== null ||
    q.minStability !== null ||
    q.minConfidence !== null ||
    q.refundOnly ||
    q.maxPriceKrw !== null ||
    q.withinDays !== null ||
    q.minTier !== null ||
    q.verifiedOnly ||
    q.newcomerOnly
  );
}

/** 등급 서열 비교용 — TIERS 순서가 곧 서열이다 */
export function tierAtLeast(tier: string, min: Tier): boolean {
  return TIERS.indexOf(tier as Tier) >= TIERS.indexOf(min);
}

/** 검색창 아래에 띄우는 추천 태그 — 무엇을 쓸 수 있는지 예시가 곧 설명서다 */
export const SUGGESTED_TAGS: ReadonlyArray<{ tag: string; hint: string }> = [
  { tag: '#무위험', hint: '틀리면 전액 환불' },
  { tag: '#상승', hint: '상승 예측만' },
  { tag: '#하락', hint: '하락 예측만' },
  { tag: '#신뢰도 4이상', hint: '리서처가 크게 건 카드' },
  { tag: '#안정성 3이상', hint: '정밀도 배팅이 있는 카드' },
  { tag: '#신규', hint: '아직 판정 이력이 없는 리서처' },
  { tag: '#인증', hint: '경력 인증 리서처' },
  { tag: '#1만원이하', hint: '예산' },
  { tag: '#일주일내', hint: '빨리 결과를 보고 싶을 때' },
];

/** 자산군 태그 문자열 (화면 안내용) */
export const ASSET_TAG_EXAMPLE = ASSET_CLASSES.map((a) =>
  a === 'KR_EQUITY' ? '#국내주식' : a === 'US_EQUITY' ? '#미국주식' : '#코인',
).join(' ');
