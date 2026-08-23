import type { RiskCategory } from './compliance';
import { classifyReview, type LabeledReview, type ScreeningOutcome } from './screeningAccuracy';
import { isStudentLabel, type StudentLabel } from './studentText';

// **운영자 판정을 학습 자료로 바꾼다** — 되먹임 고리의 마지막 한 칸.
//
// ── 왜 이 파일이 필요한가 ────────────────────────────────────────────
// 이 시스템이 출시 후에 나아지는 유일한 통로는 **운영자의 승인·반려**다. 그 판정은
// 이미 `ComplianceReview.operatorVerdict` 에 쌓이고 정확도 집계에도 쓰인다.
// 그런데 거기서 **학습 자료로 나가는 파이프가 없었다** —
// `scripts/trainExportCorpus.ts` 에 "운영자 판정은 출시 후에서 — 지금은 0건이라 없다"고
// 적혀 있고, 그 뒤로 아무도 잇지 않았다.
//
// 출시 초기에는 학생 모델이 불완전하다. 그때 가장 값진 자료가 둘이다:
//   ① **이용자가 잡은 우회** (통과시켰다가 철회 → 미탐)
//   ② **검수의 오탐** (막았다가 승인 → 하드 네거티브)
// 이 파일이 그 둘을 학습 형식으로 바꾼다.
//
// ── 판정을 라벨로 옮기는 규칙 ────────────────────────────────────────
//
//   오탐(FALSE_POSITIVE)   → 라벨 **없음**. "이건 정상이다"를 가르친다 (가장 값지다)
//   미탐(FALSE_NEGATIVE)   → 운영자가 지목한 유형. "이걸 놓쳤다"를 가르친다
//   정탐(TRUE_POSITIVE)    → 확인된 위반. 다만 **규칙이 이미 잡은 것**이라 새로 배울 것이
//                            적고, 넣으면 학생이 규칙을 흉내 내는 쪽으로 기운다
//   경미(MINOR)            → **넣지 않는다.** "지적은 타당한데 게시는 허용"이라
//                            위반이라 하면 과잉을, 정상이라 하면 미탐을 가르친다.
//                            이건 라벨이 아니라 **심각도**의 문제라 규칙에서 고쳐야 한다
//   정상 통과(TRUE_NEGATIVE) → 라벨 없음. 양이 많아 호출부가 표본을 뽑는다

/** 학습 자료로 나가는 판정의 성격 — 자료마다 처방이 다르므로 나눠서 남긴다 */
export type OperatorExampleKind =
  | 'operator_false_positive'
  | 'operator_missed'
  | 'operator_confirmed'
  | 'operator_clean';

export interface OperatorLabelResult {
  kind: OperatorExampleKind;
  labels: StudentLabel[];
}

/**
 * @근거 설계 — 경미(MINOR)를 빼는 이유는 위 표에 적었다. 정탐을 **선택**으로 두는 이유는
 *   규칙이 이미 잡은 것이라 학생에게 새 정보가 거의 없고, 넣으면 학생이 규칙의 그림자가
 *   되기 때문이다. 학생을 두는 목적은 규칙이 못 보는 자리(패러프레이즈)를 메우는 것이다.
 */
export interface OperatorExportOptions {
  /** 정탐(이미 규칙이 잡은 위반)도 넣을 것인가. 기본은 넣지 않는다 */
  includeConfirmed?: boolean;
  /**
   * 정탐을 **앵커로 일부만** 섞는다 (17차 U-6). 0~1.
   *
   * 정탐을 통째로 빼면 학생이 "이미 아는 위반"을 잊는다(치명적 망각). 통째로 넣으면
   * 규칙의 그림자가 된다. 검토가 제안한 10%가 그 사이다.
   * `includeConfirmed` 가 켜져 있으면 이 값은 무시한다(전부 넣는다).
   */
  confirmedAnchorRatio?: number;
  /** 소견 없이 통과했고 사후에도 문제없던 건도 넣을 것인가. 기본은 넣지 않는다 */
  includeClean?: boolean;
  /**
   * 정상 통과분을 **일부만** 섞는다 (18차 V-7). 0~1. 기본 0.1.
   *
   * ── 왜 필요한가 ──────────────────────────────────────────────────
   * 수동 2차의 라벨은 **보류된 건에서만** 나온다 — 규칙이 통과시킨 정상 문장은 큐에
   * 올라오지도 않는다. 그대로 두면 학습셋이 **위반 쪽으로 구조적으로 쏠린다.**
   * 자동 2차에서는 없던 편향이다(그때는 모든 건이 2차를 지났다).
   *
   * 그래서 통과분에서 무작위 표본을 꾸준히 섞는다. `includeClean` 이 켜져 있으면
   * 이 값은 무시한다(전부 넣는다).
   *
   * ⚠ **이것으로 쏠림이 다 풀리지는 않는다.** `TRUE_NEGATIVE` 는 운영자가 판매 중
   * 리포트를 보고 **유지(KEPT)를 명시적으로 누른 건**만이다(classifyReview). 소견 없이
   * 조용히 통과해 아무도 다시 안 본 리포트는 판정이 없어 애초에 조회되지 않는다 —
   * 즉 표본의 모집단이 "운영자가 한 번 더 본 정상"이지 "정상 전체"가 아니다.
   * 진짜 정상 표본이 필요하면 DART 대조군(`npm run corpus:dart`) 쪽이 답이다.
   */
  cleanSampleRatio?: number;
}

/**
 * 정상 통과분의 기본 표본 비율 (18차 V-7).
 *
 * @근거 설계 — 검토가 제안한 10%. 위반 쪽 쏠림을 되돌리기에 충분하면서 통과분이
 *   학습셋을 삼키지 않는 값이다. 실제 비율은 운영 데이터가 쌓인 뒤
 *   `summarizeOperatorExamples` 의 구성을 보고 조정한다.
 */
export const DEFAULT_CLEAN_SAMPLE_RATIO = 0.1;

/**
 * 한 건의 검수 기록이 어떤 학습 자료가 되는가. 자료가 될 수 없으면 null.
 *
 * **판정이 없으면 아무것도 만들지 않는다** — 운영자가 아직 안 본 건에 라벨을 지어내면
 * 그 임의의 판단을 모델이 배운다.
 */
export function toOperatorLabels(
  review: LabeledReview,
  opts: OperatorExportOptions = {},
): OperatorLabelResult | null {
  const outcome: ScreeningOutcome = classifyReview(review);

  if (outcome === 'FALSE_POSITIVE') {
    return { kind: 'operator_false_positive', labels: [] };
  }

  if (outcome === 'FALSE_NEGATIVE') {
    // 운영자가 유형을 안 골랐으면 **무엇을 놓쳤는지 모른다.** 지어내지 않는다 —
    // 다중 라벨 BCE 라 빈 자리는 곧 "아니다"를 가르치는 것이라, 위반 문장에
    // 빈 라벨을 붙이면 그 위반을 **정상으로** 학습시키게 된다
    const labels = studentLabelsOf(review.actualCategories);
    if (labels.length === 0) return null;
    return { kind: 'operator_missed', labels };
  }

  if (outcome === 'TRUE_POSITIVE') {
    if (!opts.includeConfirmed && !(opts.confirmedAnchorRatio && opts.confirmedAnchorRatio > 0)) {
      return null;
    }
    // 운영자가 유형을 안 골랐으면 "검수가 지적한 그대로"를 인정한 것이다
    const chosen = studentLabelsOf(review.actualCategories);
    const labels = chosen.length > 0 ? chosen : studentLabelsOf(review.findings.map((f) => f.category));
    if (labels.length === 0) return null;
    return { kind: 'operator_confirmed', labels };
  }

  if (outcome === 'TRUE_NEGATIVE') {
    // 표본 비율이 0보다 크면 호출부가 뽑는다 — 여기서는 "자료가 될 수 있다"까지만 말한다
    const ratio = opts.cleanSampleRatio ?? DEFAULT_CLEAN_SAMPLE_RATIO;
    if (!opts.includeClean && ratio <= 0) return null;
    return { kind: 'operator_clean', labels: [] };
  }

  // MINOR · UNLABELED — 위 주석의 이유로 자료가 되지 않는다
  return null;
}

/** 학생 라벨 공간 밖의 유형은 버린다 (RISKY_INSTRUMENT 처럼 종목 속성에서 오는 것들) */
function studentLabelsOf(categories: readonly RiskCategory[] | null | undefined): StudentLabel[] {
  if (!categories) return [];
  const out: StudentLabel[] = [];
  for (const c of categories) if (isStudentLabel(c) && !out.includes(c)) out.push(c);
  return out;
}

/**
 * 자료 구성을 사람이 보고 판단할 수 있게 센다.
 *
 * **비율을 보고 넣을지 정한다** — 오탐만 잔뜩 넣으면 모델이 겁을 먹어 아무것도 못 잡고,
 * 미탐만 넣으면 의심만 늘어 성실한 리서처를 막는다.
 */
export function summarizeOperatorExamples(
  results: readonly OperatorLabelResult[],
): Record<OperatorExampleKind, number> & { total: number } {
  const out = {
    operator_false_positive: 0,
    operator_missed: 0,
    operator_confirmed: 0,
    operator_clean: 0,
    total: results.length,
  };
  for (const r of results) out[r.kind] += 1;
  return out;
}
