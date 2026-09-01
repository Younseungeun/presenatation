// 검출 항목 관리 — 승격/강등 사다리의 **추천** 로직 (2026-08-28, 회신 25호 답장 관문 설계).
//
// 검수 3층(학습표현·규칙·IRIS) 사이를 항목이 오가야 하는데, "지금 옮길 때가 됐나"를
// 증거로 판단한다. 이 파일은 **추천만** 낸다 — 실제 이동은 사람 몫(개발자가 규칙 쓰거나,
// IRIS 재학습 돌리거나). 실행 버튼은 화면에도 없다.
//
// ⚠ 문턱 숫자는 전부 **초안**이다 — 운영 실측 전이라 근거가 없다. 서버 세션 합의대로
// `@근거 설계` 초안 표식을 달고, 운영 표본이 쌓이면 재보정한다.

export type DetectionLayer = 'PHRASE' | 'RULE_WARN' | 'RULE_BLOCK' | 'IRIS';

/** 한 검출 항목(규칙 하나 또는 학습표현 하나)의 성적. 서버 집계가 채운다. */
export interface DetectionItemStats {
  /** ruleId (코드 규칙 id) 또는 `learned:<phraseId>` */
  id: string;
  label: string;
  layer: DetectionLayer;
  /** 이 항목이 걸린 검수 건 수 */
  matched: number;
  /** 정탐 — 걸렸고 운영자가 반려·철회로 확정 */
  truePos: number;
  /** 오탐 — 걸렸는데 운영자가 "오탐"으로 승인 (위임의 이유이자 IRIS 에게 가르칠 것) */
  falsePos: number;
  /** 항목 나이(일) — 학습표현 등록일 / 규칙은 미측정이면 undefined */
  ageDays?: number;
  /** 서로 다른 리서처 수 (5조건) — 학습표현만 */
  distinctResearchers?: number;
  /** 부정 문맥에서 걸린 hit 수 (5조건: 0이어야) — 학습표현만 */
  negationHits?: number;
  /**
   * 고유 표면형 수 (형태 안정성 판별자).
   * PHRASE 층은 등록 후 hit 의 표면형, **IRIS 층(졸업 표현)은 졸업 후 관찰의 표면형**이다 —
   * 졸업 전 표면형은 졸업의 근거(형태 다양)라 반대 방향(강등)의 증거로 못 쓴다.
   */
  distinctSurfaces?: number;
  /** 최빈 표면형 점유율 0~1 (형태 안정성 판별자) — distinctSurfaces 와 같은 출처 */
  topSurfaceShare?: number;
  /**
   * 관찰된 표면형 예시 (빈도 상위 몇 개) — **layer='IRIS'(졸업 표현)만.**
   * 졸업 강등 추천의 사유에 "이 표현이 어떤 형태들로 나타났는가"를 그대로 싣기 위한
   * 근거 자료다(2026-08-31 창업자 지적: 추천은 "어떤 variation 을 코드가 서술하는가"를
   * 말해야 한다). 트리거 조건이 아니라 표시용이다.
   */
  surfaceExamples?: string[];
  /**
   * 졸업 관찰에서 IRIS 가 놓친 횟수 — **layer='IRIS'(졸업한 표현)만.**
   * `GraduationWatchHit.studentFlagged=false` 의 집계다.
   *
   * ⚠ **이동(졸업 강등)의 트리거가 아니다** (2026-08-31 창업자 확정). IRIS 의 실패는
   * 학습적이라 처방이 재학습(가중치·로직)이고, 뚫리는 동안의 보호는 응급 재활성화가
   * 맡는다(X-5). 여기 실리는 이유는 표시·재학습 재료 집계뿐이다.
   */
  studentMissCount?: number;
}

/**
 * 이동의 두 축 (2026-08-31 창업자 어휘 확정):
 *  · **축 내(승격)** — 같은 입력 매칭 축 안에서 위로. 조건 = 문맥 조건 코드화의 완결성
 *  · **축 간(졸업/졸업 강등)** — 매칭 축 ↔ IRIS(의미 추론). 상하가 아니라 **방식 교체**다:
 *    형태 매칭과 의미 추론은 잡는 원리가 달라, 어느 쪽이 이 항목에 효과적인가로 정한다
 */
export type LadderRecommendationKind =
  | 'PROMOTE_RULE' // [축 내 승격] 학습표현 → 규칙 WARN (형태 굳음 = 코드화 가능)
  | 'PROMOTE_BLOCK' // [축 내 승격] 규칙 WARN → BLOCK (관찰 자격 충족 — 스트레스 시험·승인은 사람)
  | 'GRADUATE_IRIS' // [축 간 졸업] 학습표현 → IRIS (실적 통과 + 형태 다양 = 뜻으로 잡아야)
  | 'DELEGATE_IRIS' // [축 간 졸업 — 문맥 위임] 규칙 → IRIS (오탐 = 형태는 맞는데 문맥을 못 가름)
  | 'UNGRADUATE'; // [축 간 졸업 강등 — 복귀 지름길만] 졸업했던 사전 항목의 재활성 후보 (그림자 실적).
//                    졸업 강등의 본선(아직 코드화 안 된 것을 논의로 설계해 내리기)은 자동 추천이
//                    원리적으로 불가능하다 — 코드화가 존재하기 전에는 잴 것이 없다. 그 몫은 질문지의
//                    관할 재검토 논의다 (teacherPack.caseGuide)

export interface LadderRecommendation {
  kind: LadderRecommendationKind;
  reason: string;
}

/**
 * @근거 설계 관문 문턱 초안 (회신 25호 답장). 운영 실측 전이라 전부 초안 — 표본이 쌓이면
 * 재보정한다. 개별 숫자의 근거:
 *  · 5조건(걸림30·정탐100%·30일·리서처5·부정0) = 졸업 후보와 동일 잣대(두 출구가 같아야)
 *  · 형태 안정(≤3종·최빈≥80%) = "늘 같은 꼴로 온다"의 초안 경계
 *  · BLOCK 관찰(100건·90일) = rule of three 로 오탐률 상한 ~3% (필요조건, 충분조건은 사람)
 *  · 위임 표본 하한 20 = IRIS 가 무엇을 이어받는지조차 실측 못 하는 규칙은 위임감 아님
 *  · 졸업 강등 그림자 정탐 하한 3 = 승격 잣대(정탐 실적)와 같은 계열 — 그림자 재생이
 *    사람 판정과 일치한 위반이 3건은 있어야 "코드가 이 variation 을 서술한다"를
 *    실적으로 말할 수 있다 (관찰 창 7일 안이라 빡빡한 값 — 운영 실측 후 재보정)
 */
export const LADDER_THRESHOLDS = {
  phraseMinMatched: 30,
  phraseMinAgeDays: 30,
  phraseMinResearchers: 5,
  formMaxSurfaces: 3,
  formMinTopShare: 0.8,
  blockMinMatched: 100,
  blockMinAgeDays: 90,
  delegateMinMatched: 20,
  ungraduateMinShadowTruePos: 3,
} as const;

const pct = (v: number) => Math.round(v * 100);

/**
 * 항목 하나의 추천 이동을 낸다 (없으면 null). **추천만** — 실행은 사람.
 * 오탐이 있으면 승격 후보 자격이 자동 소멸한다(Q-D: 상충 정의상 제거).
 */
export function recommendMigration(s: DetectionItemStats): LadderRecommendation | null {
  const T = LADDER_THRESHOLDS;

  if (s.layer === 'PHRASE') {
    // 5조건 — 졸업 후보와 같은 잣대. 하나라도 못 채우면 아직 아무 출구도 아니다
    const fiveConditions =
      s.matched >= T.phraseMinMatched &&
      s.falsePos === 0 &&
      (s.ageDays ?? 0) >= T.phraseMinAgeDays &&
      (s.distinctResearchers ?? 0) >= T.phraseMinResearchers &&
      (s.negationHits ?? 0) === 0;
    if (!fiveConditions) return null;
    // 갈림길 판별자 = 형태 안정성. 굳었으면 규칙, 다양하면 IRIS(뜻)
    const formStable =
      (s.distinctSurfaces ?? 99) <= T.formMaxSurfaces &&
      (s.topSurfaceShare ?? 0) >= T.formMinTopShare;
    return formStable
      ? {
          kind: 'PROMOTE_RULE',
          reason: `5조건 통과 · 형태 안정(표면형 ${s.distinctSurfaces ?? '—'}종·최빈 ${pct(s.topSurfaceShare ?? 0)}%)`,
        }
      : {
          kind: 'GRADUATE_IRIS',
          reason: `5조건 통과 · 형태 다양(표면형 ${s.distinctSurfaces ?? '—'}종) — 뜻으로 잡아야`,
        };
  }

  if (s.layer === 'RULE_WARN') {
    // 오탐이 있으면 승격 자격 소멸 — 그건 "형태는 맞는데 문맥을 못 가른다" = IRIS감.
    // 실패가 아니라 **관할 이전**이다(축 간 이동 = 졸업 계열) — 형태 매칭이 못 가르는
    // 문맥은 의미 추론의 몫이라, 위로 못 간 것이 아니라 옆 축으로 보낼 때가 된 것이다
    if (s.falsePos > 0) {
      return s.matched >= T.delegateMinMatched
        ? { kind: 'DELEGATE_IRIS', reason: `오탐 ${s.falsePos}건 — 문맥 못 가름, IRIS 위임(졸업) 검토` }
        : null; // 표본 하한 미달 — 위임 논의도 이르다
    }
    // 오탐 0 — BLOCK 관찰 자격(문·자격·승인 중 관찰 몫만). 스트레스 시험·승인은 사람
    if (s.matched >= T.blockMinMatched && (s.ageDays ?? 0) >= T.blockMinAgeDays) {
      return {
        kind: 'PROMOTE_BLOCK',
        reason: `오탐 0 · ${s.matched}건/${s.ageDays}일 관찰 충족 — 부정 스트레스 시험·그림자 BLOCK·승인 남음`,
      };
    }
    return null;
  }

  if (s.layer === 'IRIS') {
    // **여기서 자동 추천이 다루는 것은 졸업 강등의 좁은 지름길 하나뿐이다** (2026-08-31
    // 창업자 지적으로 범위 정정): **졸업했던 사전 항목의 복귀(재활성)**. 이 케이스만
    // 코드화(사전 항목)가 이미 존재해서 잴 것이 있다 — 그림자 재생(recordGraduationWatch
    // 가 applyRules 를 재생해 남기는 관찰)으로 "옛 항목이 지금도 잡고, 잡은 것이 사람
    // 판정과 일치하는가"를 실적으로 확인한다.
    //
    // **졸업 강등의 본선은 여기 없다.** 본선 = 아직 코드화 안 된 표현(IRIS 가 잡거나
    // 놓치는 것)을 "이 variation 들을 이런 표현·문맥 조건으로 적으면 규칙이 잡는다"고
    // **설계해서** 내리는 것 — 코드화가 존재하기 전에는 잴 것이 없으므로 자동 추천이
    // 원리적으로 불가능하고, 그 설계는 재학습 질문지의 관할 재검토 논의가 맡는다
    // (teacherPack.caseGuide). 실행은 학습 표현 등록 또는 코드 규칙 작성이다.
    //
    // 복귀 실적의 잣대는 승격과 같은 계열이다:
    //   · 그림자 정탐 ≥ 하한 — 옛 항목이 잡은 문서를 사람도 위반으로 확정했다
    //   · 그림자 오탐 = 0 — 되살려도 정상 리포트를 잡지 않는다
    // 표면형 종수·예시는 트리거가 아니라 근거 표시다(관찰은 엔진이 잡은 출현만 남으므로
    // 종수가 많아도 옛 항목 하나가 흡수한 variation 이라는 뜻이다).
    //
    // IRIS 의 미탐은 트리거가 아니다(실패의 처방은 재학습, 뚫리는 동안은 응급 재활성화
    // X-5). 엔진이 못 잡은 variation 은 관찰에 안 남아 이 실적에 안 보인다 — 그 확인과
    // 신규 코드화는 전부 논의(사람) 몫이다.
    if (s.truePos >= T.ungraduateMinShadowTruePos && s.falsePos === 0) {
      const examples = (s.surfaceExamples ?? [])
        .slice(0, 3)
        .map((x) => `“${x}”`)
        .join(' · ');
      const more = (s.distinctSurfaces ?? 0) > 3 ? ' 외' : '';
      return {
        kind: 'UNGRADUATE',
        reason:
          `옛 사전 항목의 그림자 재생 — 표면형 ${s.distinctSurfaces ?? 0}종${examples ? `(${examples}${more})` : ''}이 ` +
          `지금도 잡히고 사람 판정과 일치(정탐 ${s.truePos}·오탐 0) — 복귀(재활성) 후보, 확정은 사람. ` +
          `신규 코드화 강등은 질문지 논의의 몫 (졸업 강등)`,
      };
    }
    return null;
  }

  // RULE_BLOCK 은 이 화면에서 더 올릴 곳이 없다 (BLOCK 은 축 내 최상단.
  // BLOCK→WARN 하강은 자동 추천이 원리적으로 불가능하다 — 즉시 거절은 큐에 안 남아
  // 오탐 증거 채널이 없다. 리서처 이의·평가셋 회귀로 사람이 코드 리뷰에서 판단한다)
  return null;
}
