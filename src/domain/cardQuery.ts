import { ASSET_CLASSES, TIERS, type AssetClass, type Direction, type Tier } from './constants';

// 카드 검색어 파서.
//
// 한 줄에 두 가지를 섞어 쓴다:
//   · 자유 텍스트 → 리서처 이름 ("크립토애널리스트")
//   · 해시태그   → 조건 ("#국내주식 #상승 #신뢰도 3이상")
//
// 왜 해시태그인가: 구매 전 마스킹 때문에 **종목명으로는 검색할 수 없다**. 종목 칩으로
// 좁히면 "이 칩을 누르니 나온 카드 = 그 종목 예측"이 되어 마스킹이 통째로 뚫린다.
// 그래서 검색은 종목이 아니라 **예측의 성질**(자산군·방향·확신·조건)을 축으로 삼는다.
// 해시태그는 그 축들을 한 줄에 겹쳐 쓰기에 가장 짧은 문법이다.
//
// 파싱은 '#'로 자른다. 공백으로 자르면 "#신뢰도 3이상"처럼 사람이 자연스럽게 띄어 쓴
// 조건이 두 토막 난다. 태그 몸통 안의 공백은 지운 뒤 해석한다.

export interface CardQuery {
  /** 해시태그가 아닌 부분 — 리서처 이름 검색어 */
  text: string;
  assetClasses: AssetClass[];
  direction: Direction | null;
  /** 별점(0~5) 하한 — 카드에 뜨는 표기와 같은 축 */
  minProfitability: number | null;
  minConfidence: number | null;
  /** 안정성(종목 변동성 5구간, 시스템 산정 — domain/stability.ts) 하한 */
  minStability: number | null;
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
  minConfidence: null,
  minStability: null,
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

/** 별점 조건 — "신뢰도4이상" / "수익성3점이상" / "안정성4이상".
    안정성은 v4에서 자기 신고가 폐지된 뒤 **종목 변동성 기반 시스템 산정**으로 돌아온 축이다
    (domain/stability.ts) — 리서처가 조작할 수 없는 값이라 조건으로 걸어도 안전하다 */
const RATING_RE = /^(수익성|신뢰도|안정성)([0-5](?:\.[0-9])?)(점)?(이상)?$/;
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
    q.minConfidence !== null ||
    q.minStability !== null ||
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

/**
 * 쓸 수 있는 태그 전부 — 범주별로 묶어 검색창에서 펼쳐 보여준다.
 * 파서 바로 옆에 두는 이유: 화면이 제안하는 태그와 파서가 알아듣는 태그가 갈라지면
 * "눌렀는데 안 먹는 태그"가 생긴다. 여기가 지원 목록의 단일 기준이다.
 *
 * axis = 같은 축의 태그는 서로를 대체한다 (상승이면서 하락일 수는 없다).
 * multi = 겹쳐 고를 수 있는 축 (자산군은 여러 개를 함께 볼 수 있다).
 */
export interface TagGroup {
  title: string;
  axis: string;
  multi: boolean;
  tags: ReadonlyArray<{ tag: string; hint: string }>;
}

export const TAG_GROUPS: readonly TagGroup[] = [
  {
    title: '자산군',
    axis: 'asset',
    multi: true,
    tags: [
      { tag: '#국내주식', hint: '코스피·코스닥' },
      { tag: '#미국주식', hint: '미국 상장' },
      { tag: '#코인', hint: '암호화폐' },
    ],
  },
  {
    title: '방향',
    axis: 'direction',
    multi: false,
    tags: [
      { tag: '#상승', hint: '오른다는 예측' },
      { tag: '#하락', hint: '내린다는 예측 (숏 가능 종목만)' },
    ],
  },
  {
    title: '리서처가 건 것',
    axis: 'confidence',
    multi: false,
    tags: [
      { tag: '#신뢰도 3이상', hint: '중간 이상의 적중 확률을 신고한 카드' },
      { tag: '#신뢰도 4이상', hint: '높은 확률을 신고한 카드 — 틀리면 그만큼 크게 깎인다' },
    ],
  },
  {
    title: '예측 크기',
    axis: 'profitability',
    multi: false,
    tags: [
      { tag: '#수익성 3이상', hint: '적극 이상' },
      { tag: '#수익성 4이상', hint: '공격 이상' },
    ],
  },
  {
    title: '종목 안정성',
    axis: 'stability',
    multi: false,
    tags: [
      { tag: '#안정성 3이상', hint: '변동성 보통 이하 — 종목 변동성으로 시스템이 매긴다' },
      { tag: '#안정성 4이상', hint: '조용한 종목만' },
    ],
  },
  {
    title: '구매 조건',
    axis: 'refund',
    multi: false,
    tags: [{ tag: '#무위험', hint: '틀리면 전액 환불 (선결제 0%)' }],
  },
  {
    title: '예산',
    axis: 'budget',
    multi: false,
    tags: [
      { tag: '#1만원이하', hint: '가볍게 탐색' },
      { tag: '#3만원이하', hint: '' },
    ],
  },
  {
    title: '검증 시한',
    axis: 'within',
    multi: false,
    tags: [
      { tag: '#일주일내', hint: '빨리 결과를 보고 싶을 때' },
      { tag: '#한달내', hint: '' },
    ],
  },
  {
    title: '리서처',
    axis: 'researcher',
    multi: false,
    tags: [
      { tag: '#신규', hint: '아직 판정 이력이 없는 리서처 — 선결제가 막혀 늘 전액 환불이다' },
      { tag: '#인증', hint: '경력 인증 배지 보유' },
      { tag: '#시니어이상', hint: '' },
      { tag: '#마스터이상', hint: '' },
      { tag: '#펠로우이상', hint: '' },
    ],
  },
];

/** 이 태그가 속한 축 — 같은 축의 기존 선택을 대체할지 판단한다 */
export function tagAxisOf(tag: string): TagGroup | null {
  return TAG_GROUPS.find((g) => g.tags.some((t) => t.tag === tag)) ?? null;
}

/**
 * 태그 하나를 선택 목록에 넣는다.
 * 같은 축이면 대체(단일 축) 또는 토글(다중 축) — 겹칠 수 없는 조건이 함께 걸리는 일을 막는다.
 */
export function toggleTag(selected: readonly string[], tag: string): string[] {
  if (selected.includes(tag)) return selected.filter((t) => t !== tag);
  const group = tagAxisOf(tag);
  if (!group || group.multi) return [...selected, tag];
  // 단일 축: 같은 축의 기존 태그를 밀어낸다
  const sameAxis = new Set(group.tags.map((t) => t.tag));
  return [...selected.filter((t) => !sameAxis.has(t)), tag];
}

/** 선택한 태그 + 자유 텍스트 → 검색어 한 줄 */
export function buildQueryString(text: string, tags: readonly string[]): string {
  return [text.trim(), ...tags].filter(Boolean).join(' ').trim();
}

/** 자산군 태그 문자열 (화면 안내용) */
export const ASSET_TAG_EXAMPLE = ASSET_CLASSES.map((a) =>
  a === 'KR_EQUITY' ? '#국내주식' : a === 'US_EQUITY' ? '#미국주식' : '#코인',
).join(' ');
