// 학습 표현 사전 (순수 로직).
//
// 왜 필요한가: 결정적 규칙은 코드에 박힌 정규식이라 운영 중에 늘지 않는다. 그런데
// 운영자는 매일 "규칙도 AI도 못 잡았는데 실제로는 위반이었던 표현"을 손으로 잡아내고 있다.
// 그 판단을 문장 하나로 남겨두면, 다음 리서처는 **작성 화면에서** 같은 실수를 피할 수 있다.
//
// 즉 이 모듈은 운영자의 반려 결정이 사전 예방으로 되돌아오는 통로다:
//
//   운영자 반려 → 표현 등록 → 작성 화면이 다음 리서처에게 미리 경고
//                          ↘ 서버 검수에도 같은 표현 적용 (화면과 판정이 어긋나지 않게)
//
// 설계 원칙:
// - **심각도는 항상 WARN.** 즉시 거절은 ① 적대적 대조군에서 거절 오탐 0 이 측정됐고
//   ② 저장소에 들어가 시험이 붙잡는 패턴에만 있다(screeningEval.test.ts 의
//   blockingFalsePositives === 0 · compliance.phraseToRule 주석 · 회신 7·8호). 사전 항목은
//   그 자리에 놓일 수 없다 — 문자열 한 칸이라 문맥 조건을 담을 데가 없고, 운영 중에 사람
//   손으로 바뀌어 시험이 지키는 대상이 되지 못한다. 보류까지가 상한이고, 승격은 심각도
//   상향이 아니라 **코드 패턴으로의 이식**이다(사전 항목은 승격할 수 있다 — 다만 승격되면
//   더 이상 사전 항목이 아니다). 운영 집계(matchCount/confirmedCount/서로 다른 리서처 수)는
//   그 이식의 후보 선정 근거로만 쓴다.
// - **정규식이 아니라 문자열.** 운영자가 정규식을 쓸 수는 없다. 대신 회피 탐지와 같은
//   정규화(공백·기호 제거)를 걸어 "원 금 보 장" 류의 우회는 따라온다.
// - **표현마다 정확도를 잰다.** 사전은 방치하면 썩는다. 몇 번 걸렸고(matchCount)
//   그중 몇 번이 실제 반려로 확정됐는지(confirmedCount)를 세어 오탐 항목을 걷어낸다.
//
// ── 매칭은 이 파일에 없다 (2026-08-21 창업자 확정 · 20차 구조 개편) ──
// 예전에는 `matchLearnedPhrases` 라는 별도 경로(indexOf 한 줄)가 있었다. 그래서 사전은
// 6층 해석(간격 판별·부정 문맥·종목명 마스킹·음성 변형)을 하나도 못 받았다 — 미탐과
// 오탐이 양방향으로 났다. 지금은 **사전이 규칙 엔진의 두 번째 입력**이다:
// `applyRules(input, { phrases })` 가 코드 패턴과 같은 층·같은 가드로 돌린다.
// 이 파일에 남는 것은 등록 검증·정규화·건강도 — 즉 **입력을 다듬는 일**뿐이다.

import {
  normalizeForRules,
  type Finding,
  type RegisteredPhrase,
  type RiskCategory,
} from './compliance';

/**
 * 사전 항목 — 규칙 엔진 입력 계약(`RegisteredPhrase`)의 확장.
 * `phoneticEligible` 은 등록 시 충돌 검사의 결과다 (compliance.RegisteredPhrase 주석).
 */
export interface LearnedPhrase extends RegisteredPhrase {
  phoneticEligible: boolean;
}

/**
 * 정규화 후 길이 하한. 짧은 표현은 아무 문장에나 걸린다 —
 * "상승" 같은 두 글자를 등록하면 사전이 사실상 전면 차단기가 된다.
 */
export const PHRASE_MIN_LENGTH = 4;
/** 너무 긴 표현은 한 리포트에만 맞는 문장이라 재사용되지 않는다 */
export const PHRASE_MAX_LENGTH = 60;

/** 매칭용 정규화 — 회피 탐지와 같은 처리를 써야 "원 금 보 장"도 따라 걸린다 */
export function normalizePhrase(text: string): string {
  return normalizeForRules(text).text;
}

/** 등록 가능한 표현인지 (운영자 입력 검증) */
export function validatePhrase(phrase: string): string[] {
  const issues: string[] = [];
  const normalized = normalizePhrase(phrase);
  if (normalized.length < PHRASE_MIN_LENGTH) {
    issues.push(
      `표현이 너무 짧습니다 (공백·기호 제외 ${PHRASE_MIN_LENGTH}자 이상) — 짧은 표현은 정상 리포트에도 걸립니다`,
    );
  }
  // **2어절 하한** (22차 Y-6 검토 확정 — 대조군 기반 간섭 관문의 대체).
  // 4자 하한은 종결어미를 못 거른다: "있습니다"는 4자인데 정상 산문 어디에나 있어,
  // 등록되면 사전이 전면 차단기가 된다 (probe:interference 실측: 대조군 54문장 중 4건).
  // 표본과 대조하는 방식은 "표본이 작아 우연히 안 걸린 것"과 "안전한 표현"이 같은 값을
  // 내는 gap 17형 함정이라 버렸고(22차), 형태 제약은 표본 없이 그 구멍을 닫는다.
  // 한 낱말 표현(원금보장)은 공백을 넣어 "원금 보장"으로 적으면 된다 — 매칭은
  // 정규화본이라 동일하고, 공백을 적는 행위 자체가 "이건 어미가 아니라 표현"이라는 증명이다.
  if (phrase.trim().split(/\s+/).filter(Boolean).length < 2) {
    issues.push(
      '두 어절 이상으로 적어 주세요 (공백 포함, 예: "원금 보장") — 한 어절은 종결어미류가 그대로 등록되어 정상 리포트를 무더기로 잡습니다',
    );
  }
  if (normalized.length > PHRASE_MAX_LENGTH) {
    issues.push(
      `표현이 너무 깁니다 (공백·기호 제외 ${PHRASE_MAX_LENGTH}자 이하) — 긴 문장은 다음 리포트에서 다시 걸리지 않습니다`,
    );
  }
  return issues;
}

/**
 * 반려 시 등록할 표현의 기본값 제안.
 * 검수가 낸 인용문 중 **가장 짧은 것**을 고른다 — 짧을수록 다음 리포트에서도 걸릴
 * 확률이 높기 때문. 운영자가 그대로 쓰거나 손봐서 확정한다.
 */
export function suggestPhrase(findings: Finding[]): string {
  const usable = findings
    .map((f) => f.quote.replace(/^…|…$/g, '').trim())
    .filter((q) => validatePhrase(q).length === 0);
  if (usable.length === 0) return '';
  return usable.reduce((shortest, q) => (q.length < shortest.length ? q : shortest));
}

// ── 사전 건강도 ───────────────────────────────────────────────────────

export interface PhraseStat {
  id: string;
  phrase: string;
  category: RiskCategory;
  matchCount: number;
  confirmedCount: number;
  active: boolean;
}

/** 걸린 것 중 실제 반려로 확정된 비율 — 낮으면 그 표현이 오탐을 내고 있다는 뜻 */
export function phrasePrecision(stat: PhraseStat): number | null {
  return stat.matchCount > 0 ? stat.confirmedCount / stat.matchCount : null;
}

/** 이 횟수 이상 걸렸는데 정확도가 낮으면 재검토 대상으로 본다 (표본이 적으면 판단 보류) */
export const PHRASE_REVIEW_MIN_MATCHES = 5;
export const PHRASE_REVIEW_PRECISION = 0.5;

export function needsReview(stat: PhraseStat): boolean {
  const precision = phrasePrecision(stat);
  return (
    stat.active &&
    stat.matchCount >= PHRASE_REVIEW_MIN_MATCHES &&
    precision !== null &&
    precision < PHRASE_REVIEW_PRECISION
  );
}
