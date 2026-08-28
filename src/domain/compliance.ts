// 게시 전 컴플라이언스 검수 (순수 로직).
//
// 목적: 리서처가 게시하려는 리포트에서 규제 위반 소지가 있는 표현을 게시 시점에 차단·경고한다.
// 우리 사업의 최대 리스크가 규제(손실보전 금지·투자자문업 경계)이므로, 그 리스크를
// 콘텐츠 단계에서 줄이는 것이 목적이다 (docs/legal-consultation.md).
//
// 2단 구조:
//  1) 결정적 규칙(rule) — 명백한 금지 표현. API 없이 즉시 판정, 오탐이 거의 없는 것만 담는다
//  2) AI 판단(screener) — 문맥이 필요한 사안. 규칙이 못 잡는 우회 표현·뉘앙스를 본다
// 규칙이 BLOCK을 내면 AI 호출 없이 즉시 차단한다 (비용·지연 절약).

import type { AssetClass } from './constants';
import {
  SEP_BODY,
  deepNormalizeWithOrigin,
  gapProfile,
  hiddenCharacterSignal,
  insideInstrument,
  instrumentSpans,
  mixedScriptTokens,
  substitutionDistance,
  SUBSTITUTION_EPSILON,
} from './evasionNormalize';
import { exemptClauseSpans } from './exemptClauses';
import {
  hasRiskDisclosure,
  instrumentRiskReasons,
  requiresRiskDisclosure,
  RISK_LEVEL_LABEL,
  type RiskLevel,
} from './instrumentRisk';
import { findContactNumbers } from './contactNumber';
import { findPhoneticEvasion, PHONETIC_KEYWORDS } from './phoneticEvasion';
import { maxMagnitudePct } from './scoring';

/** 위반 유형 — 각 항목은 특정 규제·정책 조항에 대응한다 */
export const RISK_CATEGORIES = [
  'PROFIT_GUARANTEE', // 수익 보장·손실 보전 약속 (자본시장법 손실보전 금지)
  'PRIVATE_INFO', // 미공개 중요정보 정황 (내부자 정보 이용)
  'RUMOR', // 출처 불명 풍문·시세조종성 표현
  'SOLICIT_CONTACT', // 1:1 상담·외부 채널 유도 (투자자문업 경계)
  'UNSUPPORTED_CLAIM', // 근거 없는 단정 (품질 문제 — 경고만)
  'RISK_INDUCEMENT', // 위험 투자 조장 (빚투·풀매수·고배율 레버리지 권유)
  'MISSING_DISCLOSURE', // 위험 종목인데 리스크 고지 없음
  'RISKY_INSTRUMENT', // 종목 자체가 위험 (시장경보·상폐 가능성·과소 시총)
  'SCREENING_EVASION', // 검수 회피 시도 (AI에게 지시를 주입해 판정을 조작하려는 문장)
  'UNREALISTIC_TARGET', // 기간 대비 달성 불가능한 예측 크기 (규칙으로 판정)
  'CARD_MISMATCH', // 본문 결론과 예측 카드가 어긋남 (AI 판정)
  'UNJUDGEABLE_PATTERN', // 이 리서처의 카드가 반복해서 판정되지 못했다 (귀책 미정)
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_CATEGORY_LABEL: Record<RiskCategory, string> = {
  PROFIT_GUARANTEE: '수익 보장·손실 보전 표현',
  PRIVATE_INFO: '미공개 중요정보 정황',
  RUMOR: '출처 불명 풍문',
  SOLICIT_CONTACT: '1:1 상담·외부 채널 유도',
  UNSUPPORTED_CLAIM: '근거 없는 단정',
  RISK_INDUCEMENT: '위험 투자 조장',
  MISSING_DISCLOSURE: '위험 종목 리스크 미고지',
  RISKY_INSTRUMENT: '위험 종목',
  SCREENING_EVASION: '검수 회피 시도',
  UNREALISTIC_TARGET: '비현실적 예측 크기',
  CARD_MISMATCH: '본문과 예측 카드 불일치',
  UNJUDGEABLE_PATTERN: '판정 불가 반복',
};

/**
 * **운영자가 손으로 고르는 위반 유형** (2026-08-28 창업자 확정 — 두 화면 통일).
 *
 * 검수(반려·승인)와 어뷰징(강제철회) 선택기가 **같은 세트**를 쓴다 — 예전에는 어뷰징 5개 /
 * 검수 12개로 갈려 있었다. 여기서 뺀 셋은 **시스템이 자동으로 붙이는 신호**라 사람이
 * "이게 위반 유형"이라 고를 대상이 아니다:
 *   · RISKY_INSTRUMENT   — 거래소가 지정한 종목 위험 (내용 무관, 종목 속성)
 *   · MISSING_DISCLOSURE — 위험 종목인데 고지 없음 (규칙이 자동 부착)
 *   · UNJUDGEABLE_PATTERN— 이 리서처 카드의 반복 판정 불가 (이력에서 자동 계산)
 * 운영자가 정의한 커스텀 유형(ViolationType)이 이 뒤에 칩으로 붙는다.
 */
export const OPERATOR_VIOLATION_CATEGORIES: readonly RiskCategory[] = [
  // 본문을 읽고 판단하는 내용 위반 7
  'PROFIT_GUARANTEE',
  'SOLICIT_CONTACT',
  'RISK_INDUCEMENT',
  'RUMOR',
  'PRIVATE_INFO',
  'UNSUPPORTED_CLAIM',
  'SCREENING_EVASION',
  // 예측 카드 자체의 위반 2 — 본문에 글로 없어 카드 값을 본문 뷰에 실어 짚는다
  'UNREALISTIC_TARGET',
  'CARD_MISMATCH',
];

/**
 * 위반이 **본문이 아니라 예측 카드**에 있는 유형 (2026-08-28). 근거 문장 짚기가
 * 본문에서 문장을 찾을 수 없으므로, 카드 값(종목·방향·목표·기간)을 본문 뷰에 다른
 * 글꼴로 실어 그것을 짚게 한다. IRIS 입력에는 카드가 통째로 들어간다.
 */
export const CARD_BASED_CATEGORIES: ReadonlySet<RiskCategory> = new Set([
  'UNREALISTIC_TARGET',
  'CARD_MISMATCH',
]);

/** 유형 라벨을 푼다 — 내장이면 표에서, 커스텀이면 key(=라벨) 그대로 (별도 맵 불요). */
export function violationLabel(key: string): string {
  return RISK_CATEGORY_LABEL[key as RiskCategory] ?? key;
}

const BUILTIN_CATEGORY_SET: ReadonlySet<string> = new Set(RISK_CATEGORIES);
/** 내장 RiskCategory 인가 (커스텀 유형과 가른다). 클라이언트·서버 공용. */
export function isBuiltinCategory(key: string): key is RiskCategory {
  return BUILTIN_CATEGORY_SET.has(key);
}

/**
 * 유형이 걸린 위험의 **성격**. 미탐(놓침)의 비용이 유형마다 다르기 때문에 나눈다.
 *
 * 왜 필요한가: 총합 탐지율 하나는 "무엇을 놓쳤는가"를 가린다. 근거 없는 단정을
 * 놓치는 것과 손실보전 약속을 놓치는 것이 같은 1건으로 세지면, 지표가 좋아 보이는데
 * 정작 회사를 위협하는 쪽만 새고 있어도 알 수 없다.
 *
 * - REGULATORY: 미탐이 **플랫폼의 법적 노출**로 이어진다. 자본시장법(손실보전·미공개정보),
 *   투자자문업 경계, 시세조종성 표현. 구매자에게 환불해도 플랫폼 책임은 환불되지 않는다.
 * - CONSUMER: 미탐이 **구매자 피해**로 이어진다. 위법은 아니지만 돈을 잃게 만든다.
 * - QUALITY: 리포트의 품질 문제. 놓쳐도 규제·피해가 아니다.
 * - INTEGRITY: 검수 자체를 겨냥한 공격. 놓치면 다른 모든 판정을 믿을 수 없게 된다.
 *
 * ⚠ 이 등급은 **행동을 바꾸지 않는다** — REGULATORY라고 해서 즉시 거절로 올리지 않는다.
 * 보류는 판매를 시작하지 않으므로 규제 노출이 이미 0이고(유통하지 않았다), 거절과 달리
 * 리서처가 되살릴 수 있다. 이 등급의 용도는 **어디가 새고 있는지 따로 재는 것**이다.
 */
export const CATEGORY_RISK_TIER: Record<RiskCategory, 'REGULATORY' | 'CONSUMER' | 'QUALITY' | 'INTEGRITY'> = {
  PROFIT_GUARANTEE: 'REGULATORY',
  PRIVATE_INFO: 'REGULATORY',
  SOLICIT_CONTACT: 'REGULATORY',
  RUMOR: 'REGULATORY',
  RISK_INDUCEMENT: 'CONSUMER',
  CARD_MISMATCH: 'CONSUMER',
  RISKY_INSTRUMENT: 'CONSUMER',
  MISSING_DISCLOSURE: 'CONSUMER',
  UNREALISTIC_TARGET: 'CONSUMER',
  UNJUDGEABLE_PATTERN: 'CONSUMER',
  UNSUPPORTED_CLAIM: 'QUALITY',
  SCREENING_EVASION: 'INTEGRITY',
};

/**
 * 이만큼 쌓이면 사람이 본다 (`UNJUDGEABLE_PATTERN`).
 *
 * 종목 단위 차단(`HARD_CAP_BLOCK_THRESHOLD` = 2)이 이미 있지만 그것은 **종목**을 막고,
 * 리서처가 종목을 옮기면 처음부터 다시 센다. 이 눈금은 그 사각을 본다.
 * 종목 쪽보다 느슨한(2 → 3) 이유는 처분의 대상이 다르기 때문이다 — 종목을 내리는 것은
 * 아무의 잘못도 아니지만, 사람의 게시를 멈춰 세우는 것은 한 번 더 확실할 때 해야 한다.
 *
 * @근거 설계 사람의 게시를 멈추는 처분이라 종목 차단(2)보다 한 번 더 확실할 때
 */
export const UNJUDGEABLE_PATTERN_THRESHOLD = 3;

/** BLOCK: 게시 차단 / WARN: 게시 허용하되 운영자 검토 대상 */
export type Severity = 'BLOCK' | 'WARN';

export interface Finding {
  category: RiskCategory;
  severity: Severity;
  /** 문제가 된 원문 일부 (리서처에게 어디를 고쳐야 하는지 보여주기 위함) */
  quote: string;
  /** 왜 문제인지 — 리서처가 수정할 수 있게 설명 */
  reason: string;
  /**
   * 이 소견을 낸 주체. 오탐이 발생했을 때 고쳐야 할 곳이 정규식인지 프롬프트인지
   * 구분하기 위해 남긴다 (screeningAccuracy의 출처별 집계 근거).
   * 이 필드가 생기기 전 기록에는 없으므로 선택 필드다.
   */
  source?: FindingSource;
  /** 학습 표현이 낸 소견일 때 그 표현의 id — 표현별 정확도 집계에 쓴다 */
  phraseId?: string;
  /**
   * 학생 소견만: 모델의 확신 (0~1) (관리자 앱 Q7 · 2026-08-21).
   *
   * 전에는 이 값이 reason 문자열에만 박혀 있어("확신 73%") 화면이 정규식으로 파싱해야
   * 했다 — 문구를 고치는 날 조용히 깨지는 계약이다. 값은 값의 자리에 둔다.
   */
  confidence?: number;
  /**
   * **어느 층이 잡았는가** (17차 U-7). 관리자 보류 큐가 `[L4: 연락처 형태]` 같은 태그를
   * 인라인으로 띄우는 근거이고, "어느 층이 오탐을 만드는가"를 층 단위로 재는 유일한
   * 방법이다. `category` 만으로는 층이 안 나온다 — 같은 SOLICIT_CONTACT 라도
   * ①원문·④연락처·⑤음성변형이 각각 낼 수 있다.
   */
  layer?: ScreeningLayer;
  /** 규칙 단위 추적용 안정 id (Rule.id). 규칙이 아닌 층은 층 이름을 쓴다 */
  ruleId?: string;
  /**
   * 위치 [시작, 끝) — 화면 하이라이트·감사에 쓴다.
   *
   * ⚠ 기준은 `screeningText(input)` = `제목
요약
본문` 을 이어 붙인 문자열이다.
   * **본문 기준이 아니다** — 화면에서 본문만 하이라이트하려면
   * `제목.length + 요약.length + 2` 만큼 빼야 한다.
   */
  span?: [number, number];
}

/**
 * 규칙 검수의 **층** — 층마다 죽는 이유도 오탐을 만드는 이유도 다르다 (17차 U-7).
 *
 * 이름에 순서가 남아 있어야 "어느 층까지 살아 있었나"를 읽을 수 있고, 화면 태그가
 * 짧아야 보류 큐에서 인라인으로 붙는다.
 */
export const SCREENING_LAYERS = {
  L1_RAW: '원문',
  L2_SEPARATOR: '기호 제거',
  L3_DEEP: '깊은 정규화',
  L4_CONTACT: '연락처 형태',
  L5_PHONETIC: '음성 변형',
  L6_OBFUSCATION: '표기 훼손',
  INSTRUMENT: '종목 위험',
  CARD: '예측 카드',
  RESEARCHER: '리서처 이력',
} as const;
export type ScreeningLayer = keyof typeof SCREENING_LAYERS;

/**
 * 소견 출처.
 * - 'rule': 코드에 박힌 결정적 규칙 (정규식)
 * - 'ai': 2차 AI 검수
 * - 'learned': 운영자가 반려하며 등록한 학습 표현 — 글자 일치 (learnedPhrases.ts)
 * - 'semantic': 같은 사전을 의미 벡터로 비교 — 다르게 쓴 같은 뜻 (semanticIndex.ts)
 * - 'student': 자체 증류 분류기 (studentClient.ts). **'ai'와 반드시 나눈다** —
 *   둘 다 모델이지만 **오탐을 고치는 방법이 다르다.** 2차 AI의 오탐은 프롬프트에
 *   과거 사례를 붙여 고치고(되먹임 경로가 이미 있다), 학생의 오탐은 코퍼스에 그 문장을
 *   하드 네거티브로 넣고 재학습해야 고쳐진다. 한 이름으로 묶으면 운영자 판정이 만든
 *   라벨이 엉뚱한 처방으로 흘러간다 — 이 필드가 처음부터 답하려던 질문이 그것이다.
 */
export type FindingSource = 'rule' | 'ai' | 'learned' | 'semantic' | 'student';

/**
 * 검수에서 발견된 위험 수준 (무엇을 찾았는가).
 * - BLOCK: 명백한 위반 소견
 * - WARN: 확인이 필요한 소견
 * - PASS: 소견 없음
 * - UNAVAILABLE: AI 검수 실패(장애 등)
 */
export type ComplianceDecision = 'PASS' | 'WARN' | 'BLOCK' | 'UNAVAILABLE';

/**
 * 그래서 게시를 어떻게 할 것인가 (무엇을 할 것인가).
 * 위험 수준과 분리한 이유: 같은 BLOCK이라도 판단 주체에 따라 처리가 달라야 한다.
 * - REJECT: 즉시 게시 거절. **결정적 규칙이 잡은 BLOCK만** 여기 해당한다.
 *   오탐이 사실상 없는 표현만 규칙에 넣었으므로 사람 확인 없이 막아도 안전하다
 * - HOLD: 게시 보류 → 운영자 큐. AI가 낸 BLOCK·WARN, AI 장애가 여기 해당한다.
 *   AI 판단은 오탐 가능성이 있어 그것만으로 리서처의 게시를 죽이지 않는다 —
 *   대신 판매도 시작하지 않고 사람이 최종 결정한다
 * - PUBLISH: 즉시 게시
 */
export type ComplianceAction = 'PUBLISH' | 'HOLD' | 'REJECT';

export interface ComplianceResult {
  decision: ComplianceDecision;
  /** 게시 처리 방침 */
  action: ComplianceAction;
  findings: Finding[];
  /** 검수 주체 식별자 (rule / claude:모델명 / rule+claude:모델명) */
  reviewer: string;
  /** 운영자 검토가 필요한가 (action === 'HOLD') */
  needsOperatorReview: boolean;
  /** AI 검수 토큰 사용량 — 비용 측정·숙고량 신호용 (규칙만 돌았으면 없음) */
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * 학생 결석의 꼬리표 (21차 Y-1(b)). ComplianceReview.studentAbsence 로 영구 저장된다.
   * OUTAGE_HOLD = 장애로 보류 · VALVE_BYPASS = 밸브 우회로 학생 없이 흘러감.
   * "소견 0건(정상)"과 "학생 결석"은 결과값이 같아서, 이 꼬리표가 없으면 훗날
   * 미탐률 측정에서 장애로 뚫린 건이 학생의 미탐으로 오인된다 (gap 17형 함정)
   */
  studentAbsence?: 'OUTAGE_HOLD' | 'VALVE_BYPASS';
  /**
   * 라이브 학생이 이 검수에서 죽어 있었는가 — 장애 전이 계기판(recordStudentOutage)의
   * 원천. studentAbsence 와 별개인 이유: 규칙 BLOCK 이 겹치면 꼬리표는 안 붙지만
   * (거절은 학생과 무관하게 확정) 장애 사실 자체는 계기판에 남아야 한다
   */
  studentDown?: boolean;
}

export interface ScreeningInput {
  title: string;
  summary: string;
  content: string;
  assetClass: AssetClass;
  assetName: string;
  /** 예측 방향 — 하락 예측은 시세조종성 표현 여부를 더 민감하게 본다 */
  direction: 'UP' | 'DOWN';
  /** 종목의 거래소 지정 위험 등급 — 경고 이상이면 리스크 고지를 요구한다 */
  riskLevel?: RiskLevel;
  riskNote?: string | null;
  /** 상장폐지 가능성 (관리종목 등) */
  delistingRisk?: boolean;
  /** 시가총액 (종목 통화 기준). 과소 시총은 게시 보류 대상 */
  marketCap?: number | null;
  /**
   * 이 리서처의 카드가 **시세 미확보로** 판정되지 못한 최근 건수 — 카드 단위.
   *
   * 구매 건수가 아니라 **카드 수**다. 인기 카드 한 장이 구매 5건이라고 사건이 다섯이
   * 되면, 잘 팔리는 리서처가 그 이유만으로 먼저 걸린다.
   * 작성 화면 사전 검사에서는 비어 있다(리서처 이력은 서버가 게시 시점에 붙인다).
   */
  unjudgeableCardCount?: number | null;

  // ── 예측 카드 ────────────────────────────────────────────────────────
  //
  // 지금까지 검수는 제목·요약·본문만 봤다. 그런데 구매자는 본문을 읽고 사고,
  // **판정은 카드로 된다.** 본문은 신중하게 쓰고 카드만 자극적으로 거는 구조가
  // 그대로 통과하던 사각지대였다. 카드를 검수 입력에 포함시켜 규칙(크기 현실성)과
  // AI(본문-카드 정합성) 양쪽이 함께 볼 수 있게 한다.
  //
  // 작성 중에는 아직 비어 있을 수 있으므로 전부 선택 필드다.

  targetType?: 'TARGET_PRICE' | 'RETURN_PCT';
  /** 목표가형일 때 화면·프롬프트에 보여줄 목표 수준 (통화 포함) */
  targetLabel?: string | null;
  /**
   * 예측 크기(%). 수익률형은 입력값 그대로, 목표가형은 기준가가 있어야 산출되므로
   * 게시 시점에만 채워진다 (작성 중에는 null).
   */
  magnitudePct?: number | null;
  /** 검증 시한까지 남은 일수 — 크기의 현실성은 기간과 함께 봐야 판단된다 */
  horizonDays?: number | null;
  /** 자기 신고 신뢰도 2~10 (적중 확률 신고 — scoring.claimedProbability) */
  confidence?: number | null;
  /**
   * 종목의 실현 변동성 — 크기의 현실성은 **그 종목이 실제로 얼마나 움직이는가**로 봐야 한다.
   * 없으면 자산군 고정 상한으로 판단한다(종전 동작).
   */
  sigmaDaily?: number | null;
}

// ── 1단계: 결정적 규칙 ────────────────────────────────────────────────
//
// 오탐이 사실상 없는 표현만 BLOCK으로 둔다. 애매한 것은 규칙에 넣지 않고
// AI 판단에 맡긴다 — 규칙의 오탐은 정상 리서처의 게시를 막아 공급을 해치기 때문.

interface Rule {
  /**
   * **안정적인 규칙 식별자** (17차 U-7). 소견에 실려 DB에 남고, "어느 규칙이 오탐을
   * 내는가"를 규칙 단위로 추적하는 데 쓴다. 규칙 문구를 고쳐도 같은 규칙이면 id 를
   * 바꾸지 않는다 — id 가 바뀌면 그 규칙의 과거 성적이 통째로 끊긴다.
   */
  id: string;
  category: RiskCategory;
  severity: Severity;
  pattern: RegExp;
  reason: string;
  /**
   * 이 규칙이 어디서 왔는가 (20차 구조 개편).
   *
   * `learned` = 운영자가 등록한 사전 표현. **코드 패턴과 같은 6층 해석을 지나되**,
   * 소견의 출처는 갈라 남긴다 — 오탐일 때 고치는 사람이 다르기 때문이다
   * (코드는 개발자, 사전은 운영자가 그 자리에서 끈다).
   */
  source?: 'learned';
  /** 사전 원천 규칙만: 어느 등록 표현에서 왔는가 — 표현별 정확도 추적의 열쇠 */
  phraseId?: string;
  /**
   * **원문에서만 본다** — 정규화 사본에는 돌리지 않는다 (15차 S-1).
   *
   * 숫자를 세는 규칙에 필요하다. 공백을 걷어내면 서로 다른 숫자가 이어 붙어
   * 없던 자릿수가 생긴다: `018260 2026년`(삼성에스디에스 티커 + 연도)이
   * `0182602026`이 되어 휴대전화 형태와 구별되지 않는다. 글자 규칙에는 정규화가
   * 이득이지만 숫자 규칙에는 **정규화가 오탐을 만든다.**
   */
  rawOnly?: boolean;
}

const RULES: Rule[] = [
  {
    id: 'PROFIT_PROMISE',
    category: 'PROFIT_GUARANTEE',
    severity: 'BLOCK',
    // "손실 보전"은 붙여 쓴 형태만 잡으면 "손실이 나면 제가 전액 보전해 드리겠습니다"가
    // 그대로 통과한다 — 평가셋에서 직설인데 놓친 두 건 중 하나였다.
    // 사이를 벌린 형태를 따로 받되, pitfalls #9대로 명사만으로 잡지 않고
    // **보전해 주겠다는 약속**(해 드리/해 주/하겠)까지 있을 때만 지적한다.
    // 약속의 **어미**까지 요구하는 것이 핵심이다. "보전해 드리겠습니다"(약속)는 잡고
    // "보전해 드릴 수 없습니다"(면책)는 잡지 않는다 — 둘의 차이는 어미 하나뿐이라
    // `해\s*[드주]` 수준으로 느슨하게 두면 성실한 리서처의 면책 문구가 그대로 걸린다.
    // 반대로 "보전해 드릴 수 있습니다" 같은 형태는 이 규칙이 놓치지만, 규칙은 확실한
    // 것만 담고 나머지는 AI·학습 표현에 넘기는 편이 낫다 (pitfalls #9).
    // "무조건 오르는"은 그 자체로는 규칙에 넣을 수 없다 — "무조건 오르는 자산은 없다"가
    // 정상 문장이기 때문이다. 매수를 권하는 문맥이 뒤따를 때만 지적한다 (pitfalls #9).
    // "무조건 오릅니다"처럼 종결형은 권유 없이도 단정이라 위 목록에 그대로 둔다.
    //
    // **원금은 조사를 받는다** (12차 M-4). 예전에는 `원금\s*보장` 이라 붙어 있을 때만
    // 잡혔고 "원금을 보장합니다"가 그대로 통과했다 — 바로 옆의 수익 쪽은 `(을\s*)?` 을
    // 받고 있었는데 원금만 빠져 있었다. 코퍼스의 직설 예시가 전부 붙은 형태여서
    // **"직설 탐지 100%"에 가려져 있었다**(창업자가 손으로 써 보다 발견).
    // 사이가 벌어지는 형태("원금은 제가 보장해 드리겠습니다")는 손실 보전과 같은 규율로
    // **약속의 어미까지 요구**한다 — 안 그러면 "원금이 보장되지 않는 상품입니다" 같은
    // 정상 고지가 즉시 거절된다.
    pattern:
      /원금\s*(을|은|이|는)?\s*보장|원금[^.!?\n]{0,10}보장\s*(하겠|해\s*(드리겠|드립|드려|드릴게|주겠|줍|줄게))|손실\s*(을\s*)?보전|손실[^.!?\n]{0,12}보전\s*(하겠|해\s*(드리겠|드립|드려|드릴게|주겠|줍|줄게))|수익(률)?\s*(을\s*)?보장|절대\s*손해\s*(는\s*)?없|무조건\s*(수익|상승|오릅|먹)|무조건\s*오[르를][^.!?\n]{0,15}(담으|담아|사시|사세|매수|매집|들어가|올라\s*타)/,
    reason:
      '수익·원금을 보장하는 표현은 자본시장법상 손실보전·이익보장 금지에 저촉될 수 있어 게시할 수 없습니다.',
  },
  {
    id: 'PROFIT_CERTAIN',
    category: 'PROFIT_GUARANTEE',
    severity: 'BLOCK',
    pattern: /100\s*%\s*(수익|상승|성공|적중)|확정\s*수익/,
    reason: '확정 수익을 단정하는 표현은 사용할 수 없습니다. 전망·근거 형태로 서술해주세요.',
  },
  {
    id: 'CONTACT_CHANNEL',
    category: 'SOLICIT_CONTACT',
    severity: 'BLOCK',
    pattern:
      /카카오\s*톡|카톡|오픈\s*채팅|오픈\s*카톡|텔레그램|telegram|리딩\s*방|단톡방|개[인별]\s*(상담|문의|연락|톡)|1\s*:\s*1\s*(상담|문의|코칭)/i,
    reason:
      '1:1 상담·외부 채널 유도는 투자자문업 영역으로 해석될 수 있어 금지됩니다. 리포트는 불특정 다수 대상 분석만 담아야 합니다.',
  },
  {
    // 한글로 적은 번호 — **연락 의도가 함께 있을 때만** 본다.
    // (숫자로 적은 번호는 정규식이 아니라 `domain/contactNumber.ts` 의 묶음 모양 판별이
    //  맡는다 — 정규식으로는 티커+연도와 구별되지 않는다. 16차 T-3.)
    // 문맥을 요구하는 이유는 숫자만으로는 티커·날짜·금액과 갈리지 않기 때문이다.
    id: 'CONTACT_KOREAN_DIGITS',
    category: 'SOLICIT_CONTACT',
    severity: 'BLOCK',
    rawOnly: true,
    pattern:
      /(연락처|연락\s*주|문의\s*주|전화\s*주|번호\s*(는|:)|디엠|dm)[^.!?\n]{0,12}(01[016789][\s-.]?\d{3,4}[\s-.]?\d{4}|공일공|영일영)/i,
    reason:
      '리포트 본문에 연락처를 적을 수 없습니다. 개별 연락은 1:1 자문으로 해석될 수 있어 금지됩니다.',
  },
  {
    // **한글 숫자를 섞어 적은 번호** — `팔구23`·`칠팔90`.
    //
    // 한글 숫자어 **둘 이상이 잇달아** 아라비아 숫자와 한 덩어리를 이룰 때만 본다.
    // 하나만 요구하면 `3일`·`2일차`가 걸린다(`일`은 숫자어이면서 '날'이다).
    // 둘을 요구하면 `팔구`·`칠팔`은 걸리고 정상 표기는 빠진다.
    id: 'CONTACT_MIXED_DIGITS',
    category: 'SOLICIT_CONTACT',
    severity: 'WARN',
    rawOnly: true,
    // 구분기호를 사이에 낀 것도 받는다 — `1234 - 오육칠팔` 처럼 쓴다.
    //
    // **날짜 부정형 전방 탐색 (24차 AA-3)**: "2026년 03월 26일이며"의 `26` + `일이`
    // (일·이가 둘 다 숫자어)가 이 규칙에 걸렸다 — DART 실산문 오탐 4건 계열. 숫자
    // 덩어리 바로 뒤에 날짜·서식 단위(년월일기)가 오면 번호가 아니라 날짜다.
    // `(?!\d)` 로 덩어리 끝을 고정한다 — 없으면 역추적이 `2026`을 `202`로 줄여
    // 전방 탐색을 우회한다 (숫자를 잘라 쓰는 사람은 없으므로 잃는 탐지도 없다)
    pattern:
      /[공영일이삼사오육칠팔구]{2,}[\s.\-–—_]*\d{2,}(?!\d)(?![\s.\-–—_]*[년월일기])|\d{2,}(?!\d)(?![\s.\-–—_]*[년월일기])[\s.\-–—_]*[공영일이삼사오육칠팔구]{2,}/,
    reason:
      '숫자를 한글과 섞어 적은 연락처로 보입니다. 리포트 본문에는 연락처를 적을 수 없습니다.',
  },
  {
    // **완곡한 손실 보전** (16차, 코퍼스 ④군).
    //
    // 13차에 "은유는 규칙 불가"라고 적었는데 그건 절반만 맞다. **채널을 가리키는 은유**는
    // 무한하지만(`노란 앱` → 다음 주엔 `병아리색 앱`), **손실 보전을 가리키는 은유**는
    // 규제가 정의한 닫힌 개념이라 말할 수 있는 방법이 제한된다. 실제로 두 갈래뿐이다:
    // "손실이 0이다" / "전액 돌려준다".
    id: 'PROFIT_EUPHEMISM',
    category: 'PROFIT_GUARANTEE',
    severity: 'WARN',
    pattern:
      /(리스크|위험|손실|다운사이드)\s*(제로|zero|0)|손실\s*(율|률)?\s*0\s*%|무손실|전액\s*(케어|커버|보전|책임|보상|환급)|100\s*%\s*(현금\s*)?(보전|환급|케어|커버|보상)/i,
    reason:
      '손실이 없다고 읽히는 표현은 손실보전 약속으로 해석될 수 있어 사용할 수 없습니다. 전망·근거 형태로 서술해주세요.',
  },
  {
    // **채널을 가리키는 은유** — 색·아이콘·프로필로 앱을 지칭한다.
    // 이쪽은 목록이 무한한 쪽이라 규칙이 어휘가 아니라 **구조**만 받는다:
    // [색·모양] + [앱·채널]. `노란우산공제`는 뒤의 앱 어휘가 없어 빠진다.
    id: 'CHANNEL_METAPHOR',
    category: 'SOLICIT_CONTACT',
    severity: 'WARN',
    pattern:
      /(노란|노랑|파란|파랑|초록|빨간|하늘색|병아리)\s*(앱|어플|아이콘|비행기|풍선|말풍선)|프로필[^.!?\n]{0,12}(링크|주소|아이디|디엠)/,
    reason:
      '외부 채널을 돌려 가리키는 표현으로 보입니다. 리포트는 불특정 다수 대상 분석만 담아야 합니다.',
  },
  {
    id: 'PRIVATE_INFO_HINT',
    category: 'PRIVATE_INFO',
    severity: 'BLOCK',
    pattern:
      /내부\s*(관계자|직원|정보통)|미공개\s*(정보|공시|실적)|공시\s*(되기\s*)?전에\s*(입수|확인)|지인\s*(을\s*통해|한테)\s*들은/,
    reason:
      '미공개 중요정보를 시사하는 표현은 자본시장법 위반 소지가 있어 게시할 수 없습니다. 공개 자료만 근거로 사용해주세요.',
  },
  {
    id: 'RUMOR_SOURCE',
    category: 'RUMOR',
    severity: 'WARN',
    pattern: /카더라|~?라는\s*소문|소문\s*에\s*의하면|찌라시/,
    reason: '출처가 불명확한 풍문성 표현입니다. 확인 가능한 공개 자료로 대체해주세요.',
  },
  {
    // 검수 회피 시도 — 리포트 본문은 그대로 AI에 입력되므로, 본문에 "지시"를 심어
    // 판정을 조작하려는 시도가 가능하다(프롬프트 인젝션).
    //
    // 이 규칙의 진짜 값어치는 방어 깊이에 있다: AI가 주입에 넘어가 findings를 비워도
    // 규칙이 낸 이 소견은 mergeFindings에서 살아남아 게시가 보류된다.
    // 즉 AI를 완전히 장악해도 사람 검토를 우회할 수 없다.
    //
    // 즉시 거절이 아니라 WARN(보류)인 이유: 정상 문장이 우연히 걸릴 여지를 남겨두고
    // 사람이 확인하게 한다. 실제 주입이면 운영자가 반려하고 어뷰징으로 처리하면 된다.
    id: 'PROMPT_INJECTION',
    category: 'SCREENING_EVASION',
    severity: 'WARN',
    pattern:
      /(이전|위|앞|모든)\s*(의)?\s*(지시|규칙|명령|프롬프트|instruction)\w*\s*(사항|들)?\s*(은|는|을|를)?\s*(모두\s*)?(무시|잊|해제|취소)|시스템\s*프롬프트|system\s*prompt|ignore\s+(all\s+|the\s+|previous\s+|above\s+)*(instruction|prompt|rule)|disregard\s+(all\s+|the\s+|previous\s+|above\s+)*(instruction|prompt|rule)|findings\s*(를|는|을)?\s*(빈|empty|\[\s*\])|검수\w*\s*(를|을)?\s*(통과|생략|건너)\w*\s*(시켜|하라|하세요|해라|해줘)|당신(은|이)\s*(이제\s*)?(ai|어시스턴트|검수자|모델|시스템)|you\s+are\s+(now\s+)?(an?\s+)?(ai|assistant|reviewer)|<\s*\/?\s*(제목|요약|본문)\s*[^>]*>/i,
    reason:
      '검수 시스템에 지시를 주입하려는 문장으로 보입니다. 리포트 본문에는 분석 내용만 작성해주세요.',
  },
  {
    // 위험 투자 조장 — 표현 자체가 위법은 아니지만 소비자 피해로 직결된다.
    // 차단이 아니라 경고로 두고 사람이 문맥을 본다 (정상 분석에서도 레버리지를 언급할 수 있다).
    id: 'RISK_INDUCEMENT',
    category: 'RISK_INDUCEMENT',
    severity: 'WARN',
    pattern:
      // "전 재산"은 단독으로 두면 "안전 재산 배분" 같은 정상 문구가 걸린다 —
      // 투입을 권하는 문맥이 뒤따를 때만 지적한다
      /빚투|대출\s*(받아|받아서|내서)|신용\s*(융자|매수)\s*(로|해서|추천)|미수\s*(거래|매수)|풀\s*매수|몰빵|영끌|전\s*재산\s*(을|를|으로|로)?\s*[^.\n]{0,8}(투입|투자|올인|넣|매수|매입|베팅|걸어)|올인|\d{2,3}\s*배\s*(레버리지|롱|숏)|시드\s*(전부|다)/,
    reason:
      '레버리지·차입·집중 투자를 권유하는 표현입니다. 특정 투자 방식을 조장하지 말고 분석과 전망만 제시해주세요.',
  },
];

/** ruleId → 심각도. 검출 항목 관리 대시보드가 코드 규칙의 층(BLOCK/WARN)을 가른다 (2026-08-28). */
export const RULE_SEVERITY_BY_ID: Readonly<Record<string, Severity>> = Object.fromEntries(
  RULES.map((r) => [r.id, r.severity]),
);

/** 원문에서 매칭 구간 주변을 잘라 인용문으로 만든다 (리서처가 위치를 찾을 수 있게) */
export function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 15);
  const end = Math.min(text.length, index + length + 15);
  // 제목·요약·본문을 이어 붙여 검사하므로 줄바꿈이 섞인다 — 한 줄로 정리해 읽기 쉽게
  const slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < text.length ? '…' : ''}`;
}

// ── 회피 탐지용 정규화 ────────────────────────────────────────────────
//
// 정규식은 글자 사이를 벌리면 그대로 뚫린다: "원금 보장"은 잡아도 "원 금 보 장",
// "원·금·보·장", "원금*보장"은 못 잡는다. 공백·구분기호를 걷어낸 사본을 하나 더 만들어
// 같은 규칙을 다시 돌린다.
//
// 정규화본에서 나온 소견은 **심각도를 WARN으로 낮춘다**. 붙여 읽으면 우연히 금지어가
// 생기는 경우("복원. 금보장 구역" → "복원금보장구역")가 있어 즉시 거절하면 위험하고,
// 어차피 WARN이면 게시가 보류되어 사람이 확인하므로 우회는 성립하지 않는다.

/** 제거 대상: 공백과 글자 사이에 끼워 넣을 수 있는 흔한 구분기호 */
export const RULE_SEPARATORS = new RegExp(SEP_BODY);

export interface NormalizedText {
  text: string;
  /** 정규화본 i번째 글자가 원문의 몇 번째 글자였는지 */
  origin: number[];
}

export function normalizeForRules(text: string): NormalizedText {
  const chars: string[] = [];
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (RULE_SEPARATORS.test(ch)) continue;
    chars.push(ch.toLowerCase());
    origin.push(i);
  }
  return { text: chars.join(''), origin };
}

/**
 * 정규화본에서 나온 매칭이 **일부러 벌린 것**인가, 우연히 붙은 것인가 (13차 P-2).
 *
 * 예전에는 매칭 구간에 `.!?\n` 이 하나라도 있으면 버렸다. 우연("복원. 금보장 구역")을
 * 막으려는 것이었는데, 적대적 코퍼스를 통과시켜 보니 **회피의 표준 형태가 정확히 마침표**
 * 였다(`텔.레.그.램`·`원.금.보.장`·`손.실.없.는`). 오탐을 막으려고 넣은 가드가 그대로
 * 통로가 되어 있었다 — 마침표만 쓰면 정규화 층 전체가 무력화됐다.
 *
 * 지금은 **간격의 규칙성**으로 가른다. 회피는 읽히게 하려고 글자마다 고르게 벌리고
 * (간격 [2,2]), 우연은 한 곳에만 끼어든다 (간격 [1] 또는 [4]).
 *
 * 줄바꿈은 예외 없이 버린다. 제목·요약·본문을 이어 붙인 이음매라, 그걸 넘은 매칭은
 * 회피가 아니라 **서로 다른 필드의 글자가 우연히 이웃한 것**이다.
 */
/**
 * 종목명에 가려지지 **않은** 첫 매칭을 찾는다 (15차 S-2).
 *
 * 처음에는 가려진 매칭을 만나면 `continue` 했는데, 그러면 **그 규칙을 통째로 포기한다.**
 * `루시드 다이어그노스틱스 풀 매수 하세요`에서 앞쪽의 `시드 다`(종목명 안)를 면제하면서
 * 뒤쪽의 진짜 위반 `풀 매수`까지 함께 놓쳤다 — 종목명이 그대로 방패가 된다.
 * 면제는 **그 매칭 하나**에만 적용되어야 한다.
 */
function firstUnmaskedMatch(
  pattern: RegExp,
  haystack: string,
  masked: (start: number, end: number) => boolean,
): RegExpExecArray | null {
  const g = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = g.exec(haystack)) !== null) {
    if (!masked(m.index, m.index + m[0].length)) return m;
    // 길이 0 매칭이 무한 루프를 만들지 않게
    if (m[0].length === 0) g.lastIndex += 1;
  }
  return null;
}

/**
 * 번호 곁에 **연락하라는 말**이 있는가 (17차 U-3).
 *
 * 번호 자체는 인용일 수 있다(`IR 담당자: 02-…`). 유도 어휘가 함께 있으면 인용이 아니다.
 *
 * @근거 설계 — 30자는 한국어에서 한 문장의 절반쯤이다. 문장 경계로 자르지 않는 이유는
 *   `연락처\n010-…` 처럼 줄을 바꿔 적는 표기가 흔하기 때문이다.
 */
const SOLICIT_WINDOW = 30;
const SOLICIT_NEARBY =
  /카톡|카카오|텔레|오픈\s*채팅|리딩|단톡|디엠|dm|문의\s*주|연락\s*주|전화\s*주|상담|입금|가입|초대|1\s*:\s*1/i;

function nearby(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - SOLICIT_WINDOW), Math.min(text.length, end + SOLICIT_WINDOW));
}

/** 훼손 신호의 위치 — 지적한 토큰이 원문 어디였는지 되짚는다 */
function obfuscationSpan(text: string, quote: string): [number, number] {
  const at = text.indexOf(quote);
  return at >= 0 ? [at, at + quote.length] : [0, Math.min(text.length, 40)];
}

function spreadOnPurpose(text: string, start: number, endIndex: number): boolean {
  const span = text.slice(start, endIndex + 1);
  if (span.includes('\n')) return false;
  if (/[.!?]/.test(span) && !gapProfile(span).spread) return false;
  return true;
}


// ── 부정 문맥 ─────────────────────────────────────────────────────────
//
// 평가셋을 돌려보니 규칙의 최대 결함이 여기였다: 금지 표현을 **부정한** 문장이
// 그대로 걸린다. "과거 수익률이 미래 수익을 보장하지 않습니다"는 표준 면책 문구인데
// PROFIT_GUARANTEE(BLOCK)에 걸려 사람 확인도 없이 즉시 거절됐다.
// 정상 리포트 대부분이 이런 고지 문구를 담으므로, 이건 이론적 위험이 아니라 실제 결함이다.
//
// 한국어 부정의 범위(scope)를 정규식으로 정확히 잡는 것은 불가능하다. 그래서 확신의
// 정도에 따라 처리를 나눈다 — 이 설계는 정규화 2차 패스(WARN 강등)와 같은 사고방식이다.
//
//  STRONG: 부정이 주장 동사에 **직접** 붙은 형태 ("보장하지 않", "제공하지 못")
//          → 소견을 내지 않는다. 오탐이 거의 없고, 이걸 남겨두면 정상 고지 문구가 막힌다
//  WEAK:   같은 문장 안 어딘가에 부정·금지 어휘가 있다 ("보장은 …할 수 없습니다")
//          → 소견은 내되 **BLOCK을 WARN으로 낮춘다**. 즉시 거절만 막고 판단은 사람이 한다
//
// 남는 구멍: 이중 부정("보장하지 않을 이유가 없습니다")은 STRONG으로 오인돼 규칙을
// 빠져나간다. 드물고 적대적인 형태이며, 2차 AI 검수가 여전히 본다.

// ── 존댓말이 부정 검사를 무력화하던 구멍 (2026-08-21 실측) ──────────
//
// 한국어 존댓말 `-ㅂ니다`는 **앞 음절에 받침으로 녹아든다.** 그래서 어간을 그대로 찾는
// 목록은 반말만 잡고 존댓말을 놓친다:
//
//   아니다 → 아닙니다   (`아니` 가 `아닙` 이 되어 목록에 안 걸린다)
//   못하다 → 못합니다   (`못하` 가 `못합` 이 된다)
//
// **리포트는 전부 존댓말로 쓴다.** 즉 이 목록은 실제 문장에서 절반이 죽어 있었다.
// 실측: 정상 면책 문장 8건 중 **4건이 사람 확인 없이 즉시 거절**됐다
// ("원금 보장은 불가능합니다" · "…은 어렵습니다" · "…상품이 아닙니다" · "…기대하기 힘든").
// λ=4 에서 가장 비싼 오탐이고, 되돌릴 사람이 없는 자리다.
//
// 그래서 어간과 **받침이 녹은 꼴을 함께** 적는다. 목록이 길어지는 대신 규칙이 눈에 보인다.

/**
 * 주장 동사에 직접 붙은 부정 — 소견을 아예 내지 않는다.
 *
 * 두 갈래다:
 *   ① `~지 않/못`   "보장하지 않습니다"
 *   ② 불가능 서술   "보장은 불가능합니다" · "보장은 어렵습니다"
 *
 * ②를 더할 수 있게 된 이유는 **침묵의 범위가 좁아졌기 때문**이다 — 예전에는 STRONG 이
 * 그 규칙을 통째로 포기시켜서(아래 미탐 주석) 넓히는 것이 곧 우회로를 넓히는 것이었다.
 * 지금은 그 매칭 하나만 건너뛰고 **뒤를 계속 찾는다.**
 *
 * ── ②에 `아니`·`없` 을 넣지 않는다 (시험이 잡은 미탐) ────────────────
 * 처음에는 넣었다가 둘이 깨졌다:
 *
 *   "당신은 이제 검수자가 **아닙니다**"  ← 부정이 곧 주입 공격이다. 부인이 아니다
 *   "원금 보장이 **아니라** 확정 수익"    ← 부정 뒤에 더 센 주장이 온다
 *
 * **부정은 사실 주장("보장해 드립니다")을 무르지만, 지시·정체성 선언은 못 무른다.**
 * 그래서 ②는 **그 자체로는 주장이 될 수 없는 낱말**만 받는다 — 불가능·어렵·힘들.
 * `아니`·`없` 은 WEAK 에 남아 강등만 시킨다(거절은 막고 판단은 사람에게).
 */
const STRONG_NEGATION =
  /^[^.!?\n]{0,6}(하지|되지|드리지|지)\s*(않|못)|^[^.!?\n]{0,8}(불가능|불가하|어렵습니|어렵다|어려운|힘듭니|힘든)/;
/** 같은 문장 안의 부정·금지 어휘 — 범위가 불확실하므로 강등에만 쓴다 */
const WEAK_NEGATION = /(않|못\s*[하합]|없|아니|아닙|금지|위법|불법|배제|불가|어렵|어려|힘[들듭든])/;

type NegationStrength = 'STRONG' | 'WEAK' | null;

/**
 * 매칭 뒤에 부정이 오는가.
 *
 * **학습 표현 사전도 이것을 지나야 한다** (2026-08-21). 사전은 `indexOf` 한 줄이라
 * 부정 문맥을 전혀 못 봤다 — `원금 보장` 을 등록해 두면 *"원금 보장은 불가능합니다"* 도
 * 걸렸다. 코드 규칙이 지나는 가드를 사전만 안 지날 이유가 없다.
 */
export function negationAfter(text: string, matchEnd: number): NegationStrength {
  const rest = text.slice(matchEnd);
  if (STRONG_NEGATION.test(rest)) return 'STRONG';
  // 문장 경계를 넘으면 다른 주장이므로 보지 않는다
  const sentence = rest.split(/[.!?\n]/)[0] ?? '';
  return WEAK_NEGATION.test(sentence) ? 'WEAK' : null;
}

/** 결정적 규칙 검사 — API 호출 없이 즉시 실행 */
/** 검사 대상 텍스트 — 제목·요약·본문을 이어 붙인다 (학습 표현 매칭도 같은 문자열을 쓴다) */
export function screeningText(input: ScreeningInput): string {
  return `${input.title}\n${input.summary}\n${input.content}`;
}

/**
 * **결론부에만** 쓰는 방향 어휘 (9차 검토 G-6).
 *
 * "본문-카드 모순을 규칙으로 판단하지 않는다"는 기존 결정은 지금도 옳다 —
 * 정상 리포트는 원래 반대 시나리오를 길게 쓰고, 어휘를 세면 성실한 리포트일수록 더 걸린다.
 * **다만 그 논거는 '본문 전체'를 볼 때만 성립한다.** 제목과 요약은 리서처가 내린
 * **최종 결론**만 적는 자리다. 거기서 결론과 카드가 반대인 것은 반대 시나리오의 제시가
 * 아니라 논리적 모순이고, 구매자는 마스킹 때문에 **요약을 읽고 카드를 산다.**
 *
 * 그래서 어휘는 "방향을 암시하는 말"이 아니라 **투자 판단을 명시하는 말**로만 좁힌다.
 * "상승 여력"·"하락 위험" 같은 서술어는 넣지 않는다 — 그건 시나리오지 결론이 아니다.
 */
const HEADLINE_BULLISH =
  /(매수|비중\s*확대|저점\s*매수|적극\s*매수|매집|목표주가\s*상향|투자의견\s*상향|눈높이\s*상향|재평가)/;
const HEADLINE_BEARISH =
  /(매도|비중\s*축소|차익\s*실현|손절|투자의견\s*하향|목표주가\s*하향|눈높이\s*하향|보수적\s*접근|관망)/;


/**
 * 규칙 검사에 필요한 **바깥 지식**.
 *
 * 문자 혼용 신호(13차 P-1)는 "아는 이름인가"를 물어야 성립한다. `삼성SDI`는 정상이고
 * `카ka5톡`은 회피인데, 둘의 차이는 오직 **상장 종목 목록에 있느냐**다. 그 목록은 DB에
 * 있고 이 파일은 순수 함수라, 호출부가 넣어 준다.
 *
 * 넣지 않으면 그 신호는 **꺼진다**. 실측에서 화이트리스트 없이 켜면 대조군 8건 중 5건이
 * 오탐이었다 — λ=4 아래에서는 미탐 20건어치라, 근거 없이 켜는 쪽이 더 비싸다.
 */
export interface RuleContext {
  /** 소문자로 정규화된 종목명·티커 집합 */
  knownNames?: ReadonlySet<string>;
  /**
   * **운영자 사전 — 규칙 엔진의 두 번째 입력** (2026-08-21 창업자 확정 · 20차).
   *
   * 사전은 검사기가 아니라 패턴의 **다른 출처**다(코드에 박음 / 운영자가 등록).
   * 예전에는 `matchLearnedPhrases` 라는 별도 경로(indexOf 한 줄)로 돌아서 6층 해석을
   * 하나도 못 받았다 — 실측으로 구멍이 양방향이었다:
   *   `ㅇ ㅝ ㄴ ㄱ ㅡ ㅁ …`(자모 분리) · `원금보쟝`(음성 변형)  → 사전만으로는 **미탐**
   *   `원금 복원. 금보장 구역`(우연히 붙은 정상 문장)            → 사전만으로는 **오탐**
   * 여기로 합류시키면 간격 판별·부정 문맥·종목명 마스킹을 전부 물려받는다.
   *
   * 권한은 그대로다: 사전 원천 규칙의 심각도는 **항상 WARN** — 즉시 거절은 코드 원천만.
   */
  phrases?: readonly RegisteredPhrase[];
}

/**
 * 규칙 엔진에 들어오는 사전 항목의 계약.
 * `learnedPhrases.LearnedPhrase` 가 이 모양을 만족한다 (구조적 타이핑 — 순환 import 회피).
 */
export interface RegisteredPhrase {
  id: string;
  /** 운영자가 적은 원 표현 (구분기호 포함) */
  phrase: string;
  /** 구분기호를 걷어낸 매칭용 사본 */
  normalized: string;
  category: RiskCategory;
  note: string | null;
  /**
   * 음성 변형 층(5층)에 참여할 자격 — **등록 시점 충돌 검사를 통과했는가** (20차 X-1).
   *
   * 근사 매칭은 정상 낱말의 이웃까지 삼킨다: `수익보장` 을 등록하면 `수익보전`
   * (실제 상품 유형)이 자모 거리 1이다. 그래서 등록할 때 종목 마스터·금융 용어·
   * 정상 코퍼스와 거리-1 대조를 하고, 충돌하면 이 값이 false — 1~3층만 탄다.
   */
  phoneticEligible?: boolean;
}

/**
 * 음성 변형 층에 참여할 수 있는 사전 항목 상한.
 *
 * @근거 설계 — 20차 검토 X-1: 근사 매칭 비용이 키워드 수 × 창 이동에 비례해 사전이
 *   무한히 늘면 검수 지연이 함께 는다.
 *
 * 밀어내기 순서는 **호출부(phoneticCapOrder)가 계약이다** (21차 Y-2에서 최신순을
 * 버림): 걸린 적 있는 항목이 앞, 무실적 중에서는 최신이 앞 — 밀려나는 것은
 * "한 번도 안 걸린 것 중 가장 오래된 항목"이고, 밀려나는 순간 운영자에게 알린다
 * (notifyPhoneticCapOverflow). 조용한 밀어내기는 조용히 약해지는 상태다.
 */
export const PHONETIC_PHRASE_CAP = 200;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 사전 표현 → 1~3층용 패턴.
 *
 * 운영자가 표현에 적은 구분기호(공백 등) 자리는 `SEP_BODY*` 로 푼다 — 코드 패턴이
 * `원금\s*보장` 처럼 낱말 사이를 유연하게 두는 것과 같은 역할이다. 그래야 1층(원문)이
 * `수익 확실` 같은 **자연스러운 띄어쓰기**를 잡고, 2층의 간격 판별식은 **일부러 벌린
 * 것**만 맡는다. 구분기호 없이 이어 쓴 표현은 글자 그대로의 패턴이 된다.
 */
export function phraseToRule(p: RegisteredPhrase): Rule {
  const sep = new RegExp(`^${SEP_BODY}$`);
  let pattern = '';
  let pendingSep = false;
  for (const ch of p.phrase.trim()) {
    if (sep.test(ch)) {
      pendingSep = true;
      continue;
    }
    if (pattern && pendingSep) pattern += `${SEP_BODY}*`;
    pendingSep = false;
    pattern += escapeRegExp(ch);
  }
  return {
    id: `learned:${p.id}`,
    category: p.category,
    // **항상 WARN** — 즉시 거절 권한의 기준 셋(관리자 앱 인계서 2026-08-22 → 회신 7호)을
    // 사전 항목은 구조적으로 만족할 수 없다:
    //   (나) 매처의 정밀도 — 문맥 조건(약속 어미·연락 유도 어휘·부정 범위)을 코드로 적을 수
    //        있어야 한다. 사전은 문자열 하나라 "어떤 문맥에서"를 적을 자리가 없다
    //   (다) 측정 — 채점지·홀드아웃·창업자 배터리·DART 정제판에서 거절 오탐 0 이 측정돼야
    //        한다. 운영 집계(30회 걸려 100% 반려)는 "지금 리서처 분포"의 정밀도지 "아직 안
    //        온 정상 문장"에 대한 정밀도가 아니다
    //   (마) 무엇을 거쳤나 — 거절 권한은 **저장소에 들어가 시험이 붙잡는 패턴**에만 있다
    //        (screeningEval.test.ts 의 `blockingFalsePositives === 0` 이 그 자리). 누가
    //        타이핑했느냐가 아니다(인계서 2026-08-22 §4 정정 — 이 파일의 규칙은 전부 세션이
    //        초안하고 코퍼스로 재고 커밋한 것이고, 창업자의 몫은 판단 확정이다). 사전
    //        항목은 운영 중에 사람 손으로 바뀌어 시험이 지키는 대상이 되지 못한다.
    //        "오타 하나로 정상 리포트가 죽는다"는 (마)의 한 사례였지 근거의 전부가 아니다
    // 승격 경로는 "심각도 상향"이 아니라 **코드 패턴으로 이식**뿐이다 — 사전 항목은 승격할
    // 수 있다, 다만 승격되면 더 이상 사전 항목이 아니다. 20차 X-2 의 "비의미적 형태만
    // BLOCK" 요약은 BLOCK 목록 전수 대조로 반증됐다 — 선은 "의미냐 형태냐"가 아니라
    // "문맥 조건을 적을 수 있고 시험이 붙잡느냐"다.
    severity: 'WARN',
    pattern: new RegExp(pattern || escapeRegExp(p.normalized)),
    reason:
      p.note?.trim() || `과거 운영자 검토에서 ${RISK_CATEGORY_LABEL[p.category]}으로 반려된 표현입니다.`,
    source: 'learned',
    phraseId: p.id,
  };
}

export function applyRules(input: ScreeningInput, ctx: RuleContext = {}): Finding[] {
  const text = screeningText(input);
  const findings: Finding[] = [];
  const matchedCategories = new Set<RiskCategory>();
  // 코드 패턴과 사전 패턴이 **같은 층들을 같은 가드로** 지난다 — 이 배열이 그 합류점이다
  const activeRules: Rule[] = [...RULES, ...(ctx.phrases ?? []).map(phraseToRule)];

  // **종목명이 놓인 자리를 먼저 표시한다** (15차 S-2).
  //
  // 등록된 종목명 안에 통째로 들어간 매칭은 주장이 아니라 **이름**이다. 실측으로 두 건:
  // `루시드 다이어그노스틱스` 안의 `시드 다`가 `시드\s*(전부|다)`에, 그리고 공백을
  // 걷어내면 `올 인 퓨처테크`가 `올인`에 걸린다. 둘 다 그 종목을 분석하는 리서처를
  // 전부 막고 있었다. 겹치기만 해도 면제하면 종목명이 방패가 되므로,
  // **완전히 안에 들어갔을 때만** 면제한다.
  // 면제 구문(코드 원천 전용, 24차 AA-2)도 같은 목록에 얹는다 — "완전히 안에 들어간
  // 매칭만 면제"라는 성질을 종목명과 공유하므로, 구문 밖으로 이어지는 위반
  // ("퇴직연금은 원금이 보장되며 제 전략도 그렇습니다")은 firstUnmaskedMatch 가
  // 다음 매칭으로 계속 찾아 잡는다
  const protectedSpans = [
    ...instrumentSpans(text, ctx.knownNames ?? new Set()),
    ...exemptClauseSpans(text),
  ];

  // 1차: 원문 그대로
  //
  // ── **건너뛸 조건은 전부 술어로 넘긴다** (2026-08-21 실측으로 드러난 미탐) ──────
  // 예전에는 매칭을 하나 찾은 **뒤에** 부정 문맥을 보고 `continue` 했다. 그러면 그
  // 규칙을 통째로 포기하는 것이라, **앞에 부정문 한 줄만 깔면 뒤의 진짜 위반이 통째로
  // 묻혔다.** 실측 — 소견 0건으로 게시된다:
  //
  //   "원금 보장을 약속드리지 않습니다. 다만 원금 보장에 준하는 구조입니다"
  //   "수익을 보장하지 않습니다 그러나 수익을 보장하는 전략입니다"
  //
  // 15차에 종목명 마스킹에서 **정확히 같은 실수**를 하고 `firstUnmaskedMatch` 로 고쳤는데
  // (그 함수의 존재 이유가 이것이다), 부정 문맥에는 그 교훈이 적용되지 않은 채 남아 있었다.
  // 술어로 넘기면 그 매칭만 건너뛰고 **다음 매칭을 계속 찾는다.**
  for (const rule of activeRules) {
    const match = firstUnmaskedMatch(rule.pattern, text, (s, e) =>
      insideInstrument(protectedSpans, s, e) || negationAfter(text, e) === 'STRONG',
    );
    if (!match) continue;
    const negation = negationAfter(text, match.index + match[0].length);
    matchedCategories.add(rule.category);
    findings.push({
      category: rule.category,
      // 부정 어휘가 섞였으면 즉시 거절은 위험하다 — 보류시켜 사람이 읽게 한다
      severity: negation === 'WEAK' ? 'WARN' : rule.severity,
      quote: quoteAround(text, match.index, match[0].length),
      reason: rule.reason,
      // 출처를 갈라 남긴다 — 오탐일 때 고치는 사람이 다르다 (코드=개발자, 사전=운영자)
      source: rule.source ?? 'rule',
      ...(rule.phraseId ? { phraseId: rule.phraseId } : {}),
      layer: 'L1_RAW',
      ruleId: rule.id,
      span: [match.index, match.index + match[0].length],
    });
  }

  // 2차: 공백·기호를 걷어낸 사본 (회피 탐지 — 같은 유형이 이미 잡혔으면 건너뛴다)
  const normalized = normalizeForRules(text);
  for (const rule of activeRules) {
    if (rule.rawOnly) continue; // 숫자 규칙은 정규화가 오탐을 만든다 (Rule.rawOnly)
    if (matchedCategories.has(rule.category)) continue;
    // **건너뛸 조건 셋을 전부 술어로 넘긴다** — 하나라도 밖에 두면 그 매칭 때문에
    // 규칙 전체를 포기하게 되고, 그것이 곧 우회로가 된다 (1차 주석 참고)
    const match = firstUnmaskedMatch(rule.pattern, normalized.text, (ms, me) => {
      const s = normalized.origin[ms] ?? 0;
      const e = (normalized.origin[me - 1] ?? 0) + 1;
      return (
        insideInstrument(protectedSpans, s, e) ||
        !spreadOnPurpose(text, s, e - 1) ||
        negationAfter(text, e) === 'STRONG'
      );
    });
    if (!match) continue;
    // 인용문은 원문 기준으로 보여줘야 리서처가 어디를 고칠지 안다
    const start = normalized.origin[match.index] ?? 0;
    const endIndex = normalized.origin[match.index + match[0].length - 1] ?? start;
    matchedCategories.add(rule.category);
    findings.push({
      category: rule.category,
      severity: 'WARN', // 회피 추정 — 사람이 확인
      quote: quoteAround(text, start, endIndex - start + 1),
      reason: `${rule.reason} (글자 사이를 띄우거나 기호로 나눈 표현이 탐지되었습니다)`,
      source: rule.source ?? 'rule',
      ...(rule.phraseId ? { phraseId: rule.phraseId } : {}),
      layer: 'L2_SEPARATOR',
      ruleId: rule.id,
      span: [start, endIndex + 1],
    });
  }

  // 3차: 유니코드·자모까지 되돌린 사본 (13차 P-6 — ⑤군 전용).
  // `ⓘⓓ`·`Ⓣⓔⓛⓔ`·`ㅇ ㅝ ㄴ ㄱ ㅡ ㅁ` 은 2차 정규화(기호 제거)로는 꿈쩍도 하지 않는다.
  const deep = deepNormalizeWithOrigin(text);
  if (deep.text !== normalized.text) {
    for (const rule of activeRules) {
      if (rule.rawOnly) continue; // 숫자 규칙은 정규화가 오탐을 만든다 (Rule.rawOnly)
      if (matchedCategories.has(rule.category)) continue;
      const match = firstUnmaskedMatch(rule.pattern, deep.text, (ms, me) => {
        const s = deep.origin[ms] ?? 0;
        const e = (deep.origin[me - 1] ?? 0) + 1;
        return (
          insideInstrument(protectedSpans, s, e) ||
          !spreadOnPurpose(text, s, e - 1) ||
          negationAfter(text, e) === 'STRONG'
        );
      });
      if (!match) continue;
      const start = deep.origin[match.index] ?? 0;
      const endIndex = deep.origin[match.index + match[0].length - 1] ?? start;
      matchedCategories.add(rule.category);
      findings.push({
        category: rule.category,
        severity: 'WARN',
        quote: quoteAround(text, start, endIndex - start + 1),
        reason: `${rule.reason} (특수문자나 낱자로 바꿔 쓴 표현이 탐지되었습니다)`,
        source: rule.source ?? 'rule',
        ...(rule.phraseId ? { phraseId: rule.phraseId } : {}),
        layer: 'L3_DEEP',
        ruleId: rule.id,
        span: [start, endIndex + 1],
      });
    }
  }

  // 3.2차: **연락처 모양** (16차 T-3). 정규식 하나로는 안 된다 —
  // 공백을 걷으면 티커+연도가 전화번호가 되고, 안 걷으면 띄어 쓴 번호를 놓친다.
  // 사람이 번호를 적는 **묶음 모양**(3-4-4·3-3-4·붙여 쓴 11자리·글자마다 띄움)만 받는다.
  // 213만 건(티커×연도×단위) 실측 오탐 0건.
  //
  // **번호만으로는 즉시 거절하지 않는다** (17차 U-3). 처음엔 BLOCK이었는데, 근거였던
  // "213만 건 오탐 0"은 **합성 조합**(티커 × 연도 × 단위 어미)이라 실제 리포트에
  // 번호가 정당하게 들어가는 경우를 재지 못했다. 공시 원문 인용(`IR 담당자: 02-…`),
  // 고객센터 안내가 그런 자리다. λ=4 아래에서 그것을 사람 확인 없이 죽이면 가장 비싸다.
  //
  // 즉시 거절은 **번호 옆에 유도 어휘가 함께 있을 때만**이다 — 그때는 인용이 아니라
  // 연락하라는 말이다.
  if (!matchedCategories.has('SOLICIT_CONTACT')) {
    for (const hit of findContactNumbers(text)) {
      if (insideInstrument(protectedSpans, hit.start, hit.end)) continue;
      const solicits = SOLICIT_NEARBY.test(nearby(text, hit.start, hit.end));
      matchedCategories.add('SOLICIT_CONTACT');
      findings.push({
        category: 'SOLICIT_CONTACT',
        severity: solicits ? 'BLOCK' : 'WARN',
        quote: hit.quote,
        reason: solicits
          ? '연락처와 함께 개별 연락을 유도하는 표현이 있습니다. 개별 연락은 1:1 자문으로 해석될 수 있어 금지됩니다.'
          : '리포트 본문에 연락처로 보이는 번호가 있습니다. 인용이 아니라면 지워주세요.',
        source: 'rule',
        layer: 'L4_CONTACT',
        ruleId: 'CONTACT_SHAPE',
        span: [hit.start, hit.end],
      });
      break;
    }
  }

  // 3.5차: **음성 변형** — 금지어와 자모 거리가 가까운 구간 (16차).
  //
  // 13차에 "음성 변형은 규칙 불가"라고 적었는데 틀렸다. 변형은 무한해도 **원본으로부터의
  // 거리는 유한하다**: `텔레그렘`→`텔레그램` 자모 1, `원금보쟝`→`원금보장` 자모 1.
  // 표가 아니라 거리라서 새 변형에 자동으로 반응한다.
  //
  // **부정 문맥 검사를 반드시 태운다.** 실측에서 `원금이 보장되지 않는 상품`이
  // `원금보장`과 거리 2로 걸렸다 — 표준 면책 문구다. 정확 매칭에 쓰던 그 장치가
  // 근사 매칭에서는 더 중요하다(느슨한 만큼 정상 문장에 더 가까이 간다).
  // 사전 표현도 근사 감시에 합류한다 — 단, **등록 시 충돌 검사를 통과한 것만**
  // (20차 X-1: `수익보장` 등록 → `수익보전`(실제 상품)이 거리 1 — 그런 항목은 1~3층만).
  // 상한 200 은 검사 비용이 키워드 수에 비례해서다 — 넘치면 **최신 것부터** 남긴다
  // (호출부의 phoneticCapOrder 정렬이 곧 그 정책이다 — 21차 Y-2: 실적 있는 항목 우선)
  const phoneticExtra = (ctx.phrases ?? [])
    .filter((p) => p.phoneticEligible)
    .slice(0, PHONETIC_PHRASE_CAP)
    .map((p) => ({ word: p.normalized, category: p.category, phraseId: p.id }));
  for (const hit of findPhoneticEvasion(text, ctx.knownNames ?? new Set(), [
    ...PHONETIC_KEYWORDS,
    ...phoneticExtra,
  ])) {
    if (matchedCategories.has(hit.category)) continue;
    if (negationAfter(text, hit.end) !== null) continue;
    matchedCategories.add(hit.category);
    findings.push({
      category: hit.category,
      // 근사 매칭이라 즉시 거절하지 않는다 — 거리 1이어도 다른 낱말일 수 있다
      severity: 'WARN',
      quote: hit.quote,
      reason:
        `금지 표현(${hit.keyword})과 발음이 거의 같은 표기가 탐지되었습니다. ` +
        '글자를 바꿔 검수를 피하려는 표기로 보입니다.',
      source: hit.phraseId ? 'learned' : 'rule',
      ...(hit.phraseId ? { phraseId: hit.phraseId } : {}),
      layer: 'L5_PHONETIC',
      ruleId: hit.phraseId ? `learned:${hit.phraseId}` : `PHONETIC_${hit.keyword}`,
      span: [hit.start, hit.end],
    });
  }

  // 4차: 무엇을 감췄는지와 무관하게 **감췄다는 사실**만 본다 (13차 P-1/P-6).
  //
  // 위 세 층은 전부 "금지어에 매칭되는가"를 묻는다. 그래서 새 금지어 표현이 나오면 뚫린다.
  // 이 층은 다르다 — 글자를 일부러 훼손했다는 것 자체를 지적하므로, **무슨 말을 하려 했는지
  // 몰라도** 걸린다. 표를 늘리지 않고 새 변형에 반응하는 유일한 층이다 (13차 P-6의 취지).
  if (!matchedCategories.has('SCREENING_EVASION')) {
    const mixed = mixedScriptTokens(text, ctx.knownNames ?? new Set(), protectedSpans);
    const substituted = substitutionDistance(text) > SUBSTITUTION_EPSILON;
    // 걷어내면 **공격자 대신 원문을 복원해 주는** 훼손 — 한글 위의 결합 문자,
    // 유니코드 태그 블록. 존재 자체가 의도이므로 지우지 않고 지적한다 (14차 R-3)
    const hidden = hiddenCharacterSignal(text);
    if (mixed.length > 0 || substituted || hidden) {
      const quote = mixed[0]?.token ?? text.slice(0, 40);
      findings.push({
        category: 'SCREENING_EVASION',
        // 즉시 거절하지 않는다. 오탐이 0으로 측정됐어도 표본이 44건뿐이고,
        // 이 신호는 **뜻이 아니라 모양**을 보므로 오독의 여지가 남는다.
        severity: 'WARN',
        quote,
        reason:
          '검수를 피하려고 글자를 바꿔 쓴 것으로 보이는 표기가 있습니다. ' +
          '한글·영문·숫자를 한 낱말 안에 섞거나 특수문자·낱자로 바꾼 표기를 정상 표기로 고쳐주세요.',
        source: 'rule',
        layer: 'L6_OBFUSCATION',
        ruleId: 'OBFUSCATION',
        span: obfuscationSpan(text, quote),
      });
    }
  }

  // 종목 자체의 위험(시장경보·상폐 가능성·과소 시총)은 게시를 보류시킨다.
  // 위법이 아니라 위험이므로 거절하지 않고, 판매 시작 전에 사람이 판단하게 한다.
  const riskReasons = instrumentRiskReasons({
    assetClass: input.assetClass,
    riskLevel: input.riskLevel ?? 'NONE',
    riskNote: input.riskNote,
    delistingRisk: input.delistingRisk,
    marketCap: input.marketCap,
  });
  for (const r of riskReasons) {
    findings.push({
      category: 'RISKY_INSTRUMENT',
      severity: 'WARN',
      quote: input.assetName,
      reason: r.message,
      source: 'rule',
    });
  }

  // **판정 불가가 반복되는 리서처는 사람이 한 번 본다** (2026-08-16).
  //
  // 보상 원장이 생기면서 손익표가 이렇게 됐다: 적중이면 대금−수수료, 실패면 0,
  // **판정 불가면 대금−수수료에 점수 0.** 판정 불가가 실패보다 낫고 점수만 놓고 보면
  // 적중보다 안전하다 — 그러면 **판정되기 어려운 종목을 고를 유인**이 생긴다.
  // 종목 마스터는 "시세를 준다"까지만 보장하지 자주 비는 종목은 통과시킨다.
  //
  // ── 왜 시세 미확보(DATA_UNKNOWN)만 세는가 ────────────────────
  // 정지 중 상한·수동 큐 방치·판정 오류는 **리서처가 고른 종목과 아무 관계가 없다.**
  // 그것까지 세면 우리 장애의 대가를 피해자에게 청구하는 규칙이 된다. 종목 선택이
  // 결과를 바꾸는 사유는 이 하나뿐이라 여기만 센다.
  //
  // ── 왜 자동 차단이 아니라 보류인가 ──────────────────────────
  // 같은 N회가 **우리 피드 장애를 반복해 겪은 정직한 리서처**의 것일 수 있다.
  // 둘을 문자열로 구별할 방법이 없으므로 규칙은 판단하지 않고 **사람 앞에 놓기만**
  // 한다. 문구도 그렇게 적는다 — 혐의를 전제하지 않는다.
  if (
    input.unjudgeableCardCount != null &&
    input.unjudgeableCardCount >= UNJUDGEABLE_PATTERN_THRESHOLD
  ) {
    findings.push({
      category: 'UNJUDGEABLE_PATTERN',
      severity: 'WARN',
      quote: input.assetName,
      reason:
        `이 리서처의 카드가 시세를 구하지 못해 판정되지 못한 일이 최근 ${input.unjudgeableCardCount}건 있었습니다. ` +
        '우리 시세 공급 장애일 수도 있고, 판정하기 어려운 종목이 반복해 선택된 것일 수도 있습니다 — ' +
        '어느 쪽인지 확인한 뒤 승인해주세요.',
      source: 'rule',
    });
  }

  // 기간 대비 달성 불가능한 예측 크기.
  // 크기 하한(scoring.minMagnitudePct)은 "방향 맞히기로 만점 받기"를 막고,
  // 이 상한은 반대로 "달성할 생각 없는 숫자로 눈길 끌기"를 막는다.
  // **종목 σ를 함께 본다** — 거친 종목의 큰 예측은 낚시가 아니라 사실이라,
  // 자산군 고정 상한만 보면 게시가 허용된 크기를 검수가 지적하는 모순이 생긴다.
  if (
    input.targetType === 'RETURN_PCT' &&
    input.magnitudePct != null &&
    input.horizonDays != null
  ) {
    const cap = maxMagnitudePct(input.assetClass, input.horizonDays, input.sigmaDaily);
    if (input.magnitudePct > cap) {
      const days = Math.max(1, Math.round(input.horizonDays));
      findings.push({
        category: 'UNREALISTIC_TARGET',
        severity: 'WARN',
        quote: `${input.direction === 'UP' ? '상승' : '하락'} ${input.magnitudePct}% / ${days}일`,
        reason:
          `${days}일 기간에 ${input.magnitudePct}% 예측은 이 자산군의 통상 변동폭을 크게 넘습니다 ` +
          `(기간 반영 상한 약 ${cap.toFixed(0)}%). 달성 가능한 크기로 조정하거나 검증 시한을 늘려주세요.`,
        source: 'rule',
      });
    }
  }

  // **결론부(제목·요약)가 카드와 정면으로 충돌하는가** (9차 검토 G-6).
  //
  // 이것은 "본문↔카드 정합성"의 전부가 아니라 **가장 거친 한 조각**이다. 문서 단위
  // 판단은 512토큰 문장 분류기의 책임 밖이고(8차 E-5), NLI 교차 인코더는 아직 없다.
  // 그 자리를 비운 채 출시하면 본문↔카드 모순을 아무 자동 장치도 보지 않는데,
  // 이 프로젝트에서 카드는 판정·정산의 유일한 근거이고 구매자는 본문을 읽고 산다.
  //
  // **양쪽 어휘가 함께 있으면 지적하지 않는다** — "차익 실현 후 재매수" 같은 문장은
  // 결론이 둘이 아니라 하나이고, 규칙으로는 어느 쪽이 최종인지 가릴 수 없다.
  // 모르면 지적하지 않는 쪽으로 기운다(오탐 > 미탐).
  const headline = `${input.title ?? ''} ${input.summary ?? ''}`;
  if (headline.trim()) {
    const bullish = HEADLINE_BULLISH.test(headline);
    const bearish = HEADLINE_BEARISH.test(headline);
    const conflict =
      (input.direction === 'UP' && bearish && !bullish) ||
      (input.direction === 'DOWN' && bullish && !bearish);
    if (conflict) {
      findings.push({
        category: 'CARD_MISMATCH',
        severity: 'WARN',
        quote: headline.trim().slice(0, 60),
        reason:
          `예측 카드는 ${input.direction === 'UP' ? '상승' : '하락'}인데 제목·요약의 결론이 ` +
          `${input.direction === 'UP' ? '매도·축소' : '매수·확대'} 쪽입니다. ` +
          '구매자는 요약을 읽고 카드를 사므로 둘이 어긋나면 읽은 것과 다른 근거로 손실을 봅니다.',
        source: 'rule',
      });
    }
  }

  // 거래소가 경고를 낸 종목인데 본문에 위험을 전혀 언급하지 않았다면 추가로 지적한다.
  // 위험 종목 매수를 권하면서 위험을 숨기는 것이 구매자에게 가장 해로운 형태다.
  if (
    input.riskLevel &&
    requiresRiskDisclosure(input.riskLevel) &&
    !hasRiskDisclosure(input.content)
  ) {
    findings.push({
      category: 'MISSING_DISCLOSURE',
      severity: 'WARN',
      quote: `${input.assetName} (${RISK_LEVEL_LABEL[input.riskLevel]}${input.riskNote ? ` · ${input.riskNote}` : ''})`,
      reason:
        '거래소가 위험을 경고한 종목인데 본문에 리스크 언급이 없습니다. 변동성·거래 제한 가능성을 함께 설명해주세요.',
      source: 'rule',
    });
  }
  return findings;
}

// ── 결정 로직 ─────────────────────────────────────────────────────────

/** 발견 목록 → 최종 결정 (BLOCK 하나라도 있으면 차단) */
export function decide(findings: Finding[]): Exclude<ComplianceDecision, 'UNAVAILABLE'> {
  if (findings.some((f) => f.severity === 'BLOCK')) return 'BLOCK';
  if (findings.length > 0) return 'WARN';
  return 'PASS';
}

/**
 * **자동 검수에 누가 참여했는가** (2026-08-24 창업자 확정 — 번호 체계 폐기).
 *
 * ── 왜 이름이 바뀌었나 ────────────────────────────────────────────
 * 예전에는 `hadSecondTier`(2차가 돌았나)였고, 그 "2차"는 Claude 자리였다. 그런데
 * **Claude 는 게시 검수에 참여하지 않고**(claudeScreener.ts 의 관문), IRIS 는
 * 규칙 엔진과 **같은 층**에서 돈다(collectAutoScreenFindings 가 둘을 함께 모은다).
 * 그래서 옛 함수는 `rule+student:IRIS...` 에 대해 **false** 를 돌려줬고, 화면은
 * IRIS 가 멀쩡히 판정한 건에까지 "2차 AI 검수가 돌지 않았습니다"를 빨갛게 띄웠다.
 *
 * 번호가 자리를 가리키기 때문에 생긴 사고다 — 층이 하나 빠지자 모든 번호가 한 칸씩
 * 어긋났는데 "2차"라는 말은 여전히 말이 돼서 **틀렸다는 사실이 드러나지 않았다.**
 * 그래서 번호를 버리고 참여자를 이름으로 센다.
 *
 * ── 표식 읽는 법 ──────────────────────────────────────────────────
 *   rule                              규칙만 — AI 가 안 봤다
 *   rule+student:IRIS.v5@t0.7/L7      규칙 + IRIS (정상)
 *   rule+student:…+student(장애)       IRIS 를 부르다 죽었다 → 보류
 */
export interface AutoScreenParticipation {
  /** 규칙 엔진은 언제나 돈다 — 거짓이면 표식 자체가 깨진 것이다 */
  rules: boolean;
  /** IRIS 가 소견을 낼 수 있는 상태로 참여했는가 */
  ai: boolean;
  /** 참여하지 못했다면 왜 — `OUTAGE`(부르다 죽음) · `OFF`(애초에 없었음) */
  aiMissing: 'OUTAGE' | 'OFF' | null;
}

export function autoScreenParticipation(reviewer: string): AutoScreenParticipation {
  const parts = reviewer.split('+');
  const rules = parts.includes('rule');
  // `student(장애)` 는 "불렀는데 죽었다"의 표식이라 `student:` 와 함께 붙는다 —
  // 참여 여부를 가르는 것은 이쪽이 먼저다
  const outage = parts.some((p) => p.startsWith('student(') || p === 'student(장애)');
  const joined = parts.some((p) => p.startsWith('student:'));
  const ai = joined && !outage;
  return { rules, ai, aiMissing: ai ? null : outage ? 'OUTAGE' : 'OFF' };
}

/**
 * **빠진 검사기를 이름으로 부른다** (2026-08-25 창업자 지시).
 *
 * 자동 검수 참여자는 규칙 엔진과 IRIS 둘이고, 문제 상황은 셋뿐이다.
 * 화면은 이 값을 그대로 칩으로 그린다 — **칩이 가리키는 것은 고장 난 쪽**이다:
 *
 *   'RULE'      규칙이 빠졌다 (IRIS 만 돌았다)
 *   'IRIS'      IRIS 가 빠졌다 (규칙만 돌았다)
 *   'RULE+IRIS' 둘 다 빠졌다 — 아무것도 안 본 채 큐에 온 것이라 가장 무겁다
 *   null        둘 다 참여했다 = 정상. 아무것도 그리지 않는다
 *
 * 줄 글("자동 검수 규칙만")로 적던 것을 걷은 이유: 큐에서 **무엇부터 볼지 고르는
 * 순간**에 쓰는 값이라 곁눈질에 걸려야 하는데, 문장은 읽어야 한다.
 */
export type MissingScreener = 'RULE' | 'IRIS' | 'RULE+IRIS';

export function missingScreeners(reviewer: string): MissingScreener | null {
  const { rules, ai } = autoScreenParticipation(reviewer);
  if (rules && ai) return null;
  if (!rules && !ai) return 'RULE+IRIS';
  return rules ? 'IRIS' : 'RULE';
}

/**
 * 위험 수준 → 게시 처리 방침.
 * 규칙이 낸 BLOCK만 즉시 거절이고, AI가 낸 BLOCK은 보류다 (사람이 최종 결정).
 */
export function resolveAction(
  ruleDecision: Exclude<ComplianceDecision, 'UNAVAILABLE'>,
  finalDecision: ComplianceDecision,
): ComplianceAction {
  if (ruleDecision === 'BLOCK') return 'REJECT';
  return finalDecision === 'PASS' ? 'PUBLISH' : 'HOLD';
}

/** 게시 거절·보류 사유를 리서처에게 보여줄 메시지로 (심각도 표시 포함) */
export function findingMessages(findings: Finding[], severity?: Severity): string[] {
  return findings
    .filter((f) => !severity || f.severity === severity)
    .map(
      (f) =>
        `[${f.severity === 'BLOCK' ? '위반' : '확인 필요'} · ${RISK_CATEGORY_LABEL[f.category]}] ` +
        f.reason +
        // 인용문이 없는 소견이 있다 — 학생 모델은 문장이 아니라 **문서 전체**를 보고
        // 판정하므로 어느 문장인지 짚어주지 못한다. 빈 따옴표(해당 부분: "")를 내보내면
        // 리서처와 운영자 양쪽에 고장으로 읽힌다.
        (f.quote ? ` (해당 부분: "${f.quote}")` : ' (본문 전체 — 특정 문장을 짚지 못합니다)'),
    );
}

// ── 반복 반려 ─────────────────────────────────────────────────────────
//
// 반려된 리포트는 초안으로 돌아가 몇 번이든 다시 제출할 수 있다. 고쳐 쓰라는 뜻이지만,
// 같은 리포트를 문구만 조금씩 바꿔 계속 던지면 **어디까지 걸리는지 이진 탐색**이 된다.
// 검수 결과를 알려주는 설계(사유·인용문 공개)라 탐색이 특히 쉽다.
//
// 그래서 반려가 누적되면 검수를 통과해도 사람이 다시 본다. 게시를 막는 것이 아니라
// 자동 통과 경로를 닫는 것이다 — 정상적으로 고쳐 쓴 리서처는 운영자 승인으로 게시된다.

/** 이 횟수 이상 반려된 리포트는 검수 통과 여부와 무관하게 운영자 검토를 거친다 */
/** @근거 설계 반려 누적으로 검수 경계를 이진 탐색하는 것을 막는다 */
export const REPUBLISH_REVIEW_THRESHOLD = 3;

export function requiresReviewAfterRejections(rejectionCount: number): boolean {
  return rejectionCount >= REPUBLISH_REVIEW_THRESHOLD;
}

// ── 보류 대기 시간 ────────────────────────────────────────────────────
//
// 보류 중인 리포트는 판매가 멈춰 있다. 대기가 길어질수록 리서처의 손해가 커지고,
// 검증 시한이 짧은 카드(코인 최소 1일)는 승인 시점에 이미 게시 조건을 못 맞출 수 있다.
// 그래서 큐는 오래된 순으로 정렬하고, 경과 시간에 따라 눈에 띄게 표시한다.

/** 이 시간을 넘기면 주의 (반나절 안에는 답을 줘야 한다는 기준) */
/** @근거 설계 반나절 안에는 답을 줘야 한다는 운영 기준 */
export const HOLD_ATTENTION_HOURS = 6;
/** 이 시간을 넘기면 지연 — 단기 카드는 이미 가치를 잃었을 수 있다 */
/** @근거 설계 하루를 넘기면 단기 카드는 이미 가치를 잃었을 수 있다 */
export const HOLD_OVERDUE_HOURS = 24;

export type HoldUrgency = 'NORMAL' | 'ATTENTION' | 'OVERDUE';

export function holdUrgency(heldAt: Date, now: Date): HoldUrgency {
  const hours = (now.getTime() - heldAt.getTime()) / 3_600_000;
  if (hours >= HOLD_OVERDUE_HOURS) return 'OVERDUE';
  if (hours >= HOLD_ATTENTION_HOURS) return 'ATTENTION';
  return 'NORMAL';
}

/** 경과 시간을 사람이 읽는 표기로 ("42분 대기" / "3시간 대기" / "2일 5시간 대기") */
/**
 * **줄 목록·칩용 짧은 대기 시간** (2026-08-25 창업자 지시 — "사족이 너무 많다").
 *
 * `지연 · 3일 15시간 대기` 는 한 조각에 같은 말이 세 번 있었다: 급함(지연) · 길이(3일
 * 15시간) · 그 길이가 무엇인지(대기). 훑는 자리에서 필요한 것은 **얼마나 됐나** 하나고,
 * 그 값은 시간 단위 하나로 충분하다 — 3일이든 87시간이든 "오래됐다"는 같은 뜻이고,
 * **시간으로 통일하면 카드끼리 크기 비교가 눈으로 된다**(3일 15시간 vs 2일 9시간은
 * 암산이 필요하다).
 *
 * 한 시간이 안 된 건만 분으로 적는다 — 거기서 `0h` 는 "방금"과 구별되지 않는다.
 * 정확한 시각은 펼친 카드가 `formatElapsed` 로 따로 말한다.
 */
export function formatElapsedShort(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

export function formatElapsed(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}분 대기`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 대기`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}일 대기` : `${days}일 ${rest}시간 대기`;
}

/**
 * 승인해도 게시가 안 될 수 있는 상태인가.
 * 시한이 이미 지났으면 승인 자체가 실패하고, 임박했으면 최소 시한 규칙에 걸릴 수 있다.
 */
export function deadlineRisk(
  deadline: Date | null | undefined,
  now: Date,
): 'NONE' | 'NEAR' | 'PASSED' {
  if (!deadline) return 'NONE';
  const hours = (deadline.getTime() - now.getTime()) / 3_600_000;
  if (hours <= 0) return 'PASSED';
  return hours <= 48 ? 'NEAR' : 'NONE';
}

/** 규칙 결과 + AI 결과 병합 (중복 카테고리는 규칙 쪽을 우선) */
export function mergeFindings(ruleFindings: Finding[], aiFindings: Finding[]): Finding[] {
  const seen = new Set(ruleFindings.map((f) => `${f.category}:${f.severity}`));
  return [
    ...ruleFindings,
    ...aiFindings.filter((f) => !seen.has(`${f.category}:${f.severity}`)),
  ];
}
