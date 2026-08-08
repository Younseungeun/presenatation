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
// - **심각도는 항상 WARN.** 사람이 입력한 문자열이 즉시 거절 권한을 갖게 하면,
//   오타 하나로 정상 리포트가 사람 확인 없이 죽는다. 보류까지가 상한이다.
// - **정규식이 아니라 문자열.** 운영자가 정규식을 쓸 수는 없다. 대신 회피 탐지와 같은
//   정규화(공백·기호 제거)를 걸어 "원 금 보 장" 류의 우회는 따라온다.
// - **표현마다 정확도를 잰다.** 사전은 방치하면 썩는다. 몇 번 걸렸고(matchCount)
//   그중 몇 번이 실제 반려로 확정됐는지(confirmedCount)를 세어 오탐 항목을 걷어낸다.

import {
  normalizeForRules,
  quoteAround,
  RISK_CATEGORY_LABEL,
  screeningText,
  type Finding,
  type RiskCategory,
  type ScreeningInput,
} from './compliance';

export interface LearnedPhrase {
  id: string;
  /** 운영자가 입력한 원래 표현 (화면 표시용) */
  phrase: string;
  /** 매칭에 쓰는 정규화본 — 저장 시점에 확정한다 */
  normalized: string;
  category: RiskCategory;
  /** 왜 문제인지 — 리서처에게 그대로 보여준다 */
  note: string | null;
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

/**
 * 학습 표현 매칭 — 정규화본끼리 부분 문자열로 비교한다.
 * 인용문은 원문 위치로 되돌려 보여줘야 리서처가 어디를 고칠지 안다.
 */
export function matchLearnedPhrases(
  input: ScreeningInput,
  phrases: LearnedPhrase[],
): Finding[] {
  if (phrases.length === 0) return [];
  const text = screeningText(input);
  const normalized = normalizeForRules(text);

  return phrases.flatMap((p): Finding[] => {
    if (!p.normalized) return [];
    const at = normalized.text.indexOf(p.normalized);
    if (at < 0) return [];
    const start = normalized.origin[at] ?? 0;
    const endIndex = normalized.origin[at + p.normalized.length - 1] ?? start;
    return [
      {
        category: p.category,
        severity: 'WARN', // 사람이 등록한 표현은 보류까지만 (§ 설계 원칙)
        quote: quoteAround(text, start, endIndex - start + 1),
        reason:
          p.note?.trim() ||
          `과거 운영자 검토에서 ${RISK_CATEGORY_LABEL[p.category]}으로 반려된 표현입니다.`,
        source: 'learned',
        phraseId: p.id,
      },
    ];
  });
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
