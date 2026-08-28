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
  /** 오탐 — 걸렸는데 운영자가 "오탐"으로 승인 (강등의 이유이자 IRIS 에게 가르칠 것) */
  falsePos: number;
  /** 항목 나이(일) — 학습표현 등록일 / 규칙은 미측정이면 undefined */
  ageDays?: number;
  /** 서로 다른 리서처 수 (5조건) — 학습표현만 */
  distinctResearchers?: number;
  /** 부정 문맥에서 걸린 hit 수 (5조건: 0이어야) — 학습표현만 */
  negationHits?: number;
  /** 고유 표면형 수 (형태 안정성 판별자) — 학습표현만 */
  distinctSurfaces?: number;
  /** 최빈 표면형 점유율 0~1 (형태 안정성 판별자) — 학습표현만 */
  topSurfaceShare?: number;
}

export type LadderRecommendationKind =
  | 'PROMOTE_RULE' // 학습표현 → 규칙 WARN (형태 굳음)
  | 'GRADUATE_IRIS' // 학습표현 → IRIS 졸업 (형태 다양 = 뜻으로)
  | 'PROMOTE_BLOCK' // 규칙 WARN → BLOCK (관찰 자격 충족 — 스트레스 시험·승인은 사람)
  | 'DEMOTE_IRIS'; // 규칙 → IRIS 강등 (문맥 못 가름)

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
 *  · 강등 표본 하한 20 = IRIS 가 무엇을 이어받는지조차 실측 못 하는 규칙은 강등감 아님
 */
export const LADDER_THRESHOLDS = {
  phraseMinMatched: 30,
  phraseMinAgeDays: 30,
  phraseMinResearchers: 5,
  formMaxSurfaces: 3,
  formMinTopShare: 0.8,
  blockMinMatched: 100,
  blockMinAgeDays: 90,
  demoteMinMatched: 20,
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
    // 오탐이 있으면 승격 자격 소멸 — 그건 "형태는 맞는데 문맥을 못 가른다" = IRIS감
    if (s.falsePos > 0) {
      return s.matched >= T.demoteMinMatched
        ? { kind: 'DEMOTE_IRIS', reason: `오탐 ${s.falsePos}건 — 문맥 못 가름, IRIS 위임 검토` }
        : null; // 표본 하한 미달 — 강등 논의도 이르다
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

  // RULE_BLOCK·IRIS 는 이 화면에서 더 올릴 곳이 없다(BLOCK 은 최상단, IRIS 강등은 규칙 쪽에서 본다)
  return null;
}
