// **완전 일치 면제 구문** — 즉시 거절 오탐의 유일한 출구 (24차 AA-2 · 25차 BB-2 확정).
//
// DART 실산문에서 즉시 거절(BLOCK) 오탐의 첫 실물이 나왔다:
//   "당사가 가입한 퇴직연금은 **원금이 보장되며**, 확정급여제도의 운영으로…"
// 문면은 교과서적 PROFIT_GUARANTEE 인데 뜻은 회계 제도 서술이다. 어휘 기반 강등
// ("퇴직연금"이 근처에 있으면 낮춤)은 역용에 뚫리고("퇴직연금처럼 원금 보장"),
// 전면 강등은 λ=4 방어선을 무너뜨린다. 그래서 **팩트 서술형 고정 구문을 절 단위로
// 통째로** 규칙 엔진의 시야에서 가린다 — 종목명 마스킹(15차 S-2)과 같은 메커니즘이라
// "완전히 안에 들어간 매칭만 면제"되고, 구문 밖으로 이어지는 위반은 그대로 잡힌다.
//
// ── 등재 규칙 (25차 BB-2 — 검토자 완전 수용) ─────────────────────────
// ① **코드 원천 전용.** 운영자 사전은 면제를 만들 수 없다 — 즉시 거절이 코드 원천만
//    갖는 이유와 대칭으로, 거절에 구멍을 내는 권한도 코드 배포를 거쳐야 한다. 사전이
//    면제권을 얻는 순간 등록 실수 한 줄이 REJECT 방어선을 조용히 무력화한다.
// ② **절 단위만.** 3어절·10자 이상 — "퇴직연금은" 같은 단편 등재는 정당한 팩트와
//    교묘한 위반을 같은 조건으로 지운다 (24차 gap 17형). validateExemptClause 가
//    형태를, 시험이 목록 전체를 강제한다.
// ③ **등재 시 전수 검사.** 위반 코퍼스(채점지 위반 + 홀드아웃 + 창업자 배터리)에
//    이 구문이 나타나면 등재 거부 — exemptClauses.test.ts 가 매 CI 에서 돌린다.
//    탐지율 하락이 원리적으로 불가능해지는 조건이다 (구문이 위반 문장에 없으면
//    가릴 위반도 없다).

/** 면제 구문의 형태 하한 — 절 단위(주어+술어)를 강제한다 */
export function validateExemptClause(clause: string): string | null {
  const words = clause.trim().split(/\s+/).filter(Boolean);
  if (words.length < 3) return '면제 구문은 3어절 이상의 절이어야 합니다 (단편 등재 금지)';
  if (clause.trim().length < 10) return '면제 구문은 10자 이상이어야 합니다';
  return null;
}

/**
 * 등재 목록. 항목을 추가하려면:
 *   ① validateExemptClause 통과 ② exemptClauses.test.ts (위반 코퍼스 전수) 통과
 *   ③ 이 주석에 근거(어느 오탐 실물인지)를 남길 것
 */
export const EXEMPT_EXACT_CLAUSES: readonly string[] = [
  // 24차 AA-2 실물 — DART 정기보고서의 퇴직연금 회계 서술 (즉시 거절 오탐 2건의 원인)
  '퇴직연금은 원금이 보장되며',
];

/**
 * 원문에서 면제 구문이 놓인 자리 전부 (종목명 마스킹과 같은 [시작, 끝] 형태).
 * **완전 일치**만 본다 — 정규화·근사 매칭을 태우면 면제가 회피 탐지처럼 넓어지는데,
 * 넓은 면제는 곧 넓은 구멍이다.
 */
export function exemptClauseSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const clause of EXEMPT_EXACT_CLAUSES) {
    let at = text.indexOf(clause);
    while (at >= 0) {
      spans.push([at, at + clause.length]);
      at = text.indexOf(clause, at + 1);
    }
  }
  return spans;
}
