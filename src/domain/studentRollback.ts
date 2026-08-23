import { classifyReview, type LabeledReview } from './screeningAccuracy';

// 학생 모델을 **언제 끌 것인가** (9차 G-4 · 11차 K-1/K-2 개정).
//
// 채택은 홀드아웃 손코퍼스에서 정했다: 새로 잡은 미탐 17건, 새로 만든 오탐 0건.
// 그런데 그 0건은 **정상 34건짜리 표본**에서 나온 값이라, 다음 34건에서 1건이 나오는
// 것은 아무 이상도 아니다. 켠 뒤에 무엇을 보고 끌 것인지가 정해져 있지 않으면
// 두 가지 실패가 모두 열려 있다 — 오탐 한두 건에 놀라 성급히 끄거나, 계속 나빠지는데
// 아무도 눈치채지 못하거나.
//
// **잣대는 채택선과 같아야 한다.** 켤 때 쓴 공식과 끌 때 쓰는 공식이 다르면 두 판단이
// 서로를 반박한다. 그래서 여기서도 순이익을 쓴다:
//
//     순이익 = (학생이 잡은 진짜 위반) − λ × (학생이 만든 오탐)
//
// 차이는 **누가 채점하느냐**뿐이다. 채택선은 손코퍼스의 사람 라벨이 채점했고,
// 여기서는 운영자 판정이 채점한다 — 그쪽이 진짜 정답이다.

/** @근거 계약 — scripts/evalStudent.ts 의 COST_RATIO 와 **같은 수여야 한다**.
 *  켤 때와 끌 때의 비용비가 다르면 두 판단이 서로를 반박한다 */
export const ROLLBACK_COST_RATIO = 4;

/**
 * 판단에 쓰는 이동 창의 크기.
 *
 * @근거 설계 — 규칙 단독 오탐률이 17.6%다. 학생이 그보다 유의미하게 나빠졌는지 보려면
 *   오탐이 몇 건은 관측돼야 하는데, 50건 창이면 규칙 수준(17.6%)에서 기대 오탐이
 *   약 9건이라 1~2건의 잡음에 창 전체가 뒤집히지 않는다. 10건이면 한 건이 10%p라
 *   매주 껐다 켰다 하게 된다.
 *   ⚠ 이 값은 운영 데이터 0건 상태의 **추정**이다. 실제 유입량을 보고 다시 잡을 것.
 */
export const ROLLBACK_WINDOW = 50;

/**
 * 윌슨 하한 판정을 쓰기 위한 **최소 표본** (11차 K-2).
 *
 * @근거 설계 — 하한식만 두면 **명시적 오탐 신고 1건에도 격발한다**(n=1, p̂=1 에서
 *   95% 하한이 0.207 > 0.2). 그런데 한 건으로는 "모델이 나쁘다"와 "그 리포트가
 *   유별났다"가 갈리지 않는다. 5는 검토가 예로 든 표본 크기이고, 거기서 4건이
 *   신고돼야 하한이 무너진다(0.376) — 명백한 신호에만 조기 격발한다.
 */
export const WILSON_MIN_SAMPLE = 5;

/** @근거 규칙 — 95% 양측 신뢰구간의 표준정규 분위수. 통계량의 정의값이라 고를 수 없다 */
const WILSON_Z = 1.96;

/**
 * **윌슨 점수 구간의 하한** — 표본이 적을 때 단순 비율 대신 쓴다 (11차 K-2).
 *
 * 단순 비율(`fp/n`)은 표본이 작을수록 극단으로 튄다 — 3건 중 1건이면 33%지만 그것으로
 * 참값을 33%라고 말할 수 없다. 윌슨 하한은 "95% 확신을 갖고 말할 수 있는 최솟값"이라,
 * **표본이 적으면 저절로 보수적**이 되고 쌓일수록 단순 비율에 수렴한다.
 *
 * 정규 근사(Wald)를 쓰지 않는 이유: p̂ 가 0이나 1에 가까울 때 구간이 무너지는데
 * (n=5, fp=5 면 Wald 하한이 정확히 1.0), 출시 직후가 정확히 그 구간이다.
 */
export function wilsonLowerBound(successes: number, n: number, z = WILSON_Z): number {
  if (n <= 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, center - margin);
}

/**
 * 이 건이 **격하 판정의 표본이 되는가**, 된다면 어느 쪽인가 (11차 K-1).
 *
 * ── 왜 `classifyReview` 를 그대로 쓰지 않는가 ──────────────────────
 * 정확도 지표는 **승인을 기본 오탐으로** 센다. 그 기본값의 근거는 기록돼 있고 그 자체로
 * 타당하다 — *"승인의 대다수가 과잉 지적이고, 예외만 체크하게 해야 운영자 손이 덜
 * 가면서 라벨이 비지 않는다"*. **정확도를 표시하는 용도로는 옳다.**
 *
 * 그런데 10차에 같은 라벨이 **자동 격하의 입력**이 되면서 뜻이 달라졌다. λ=4 가 그
 * 방향으로 증폭해, 실측으로 **25건 중 6건만 무심코 승인해도 학생이 영구히 꺼졌다**
 * (`scripts/probeCarelessApproval.ts`). 큐가 밀린 날 스무 건을 빠르게 승인하는 것은
 * 정상 운영인데, 그날 모델이 내려간다 — **모델이 나빠서가 아니라 사람이 바빠서**다.
 *
 * → **지표용 라벨과 억제 신호를 분리한다.** 여기서는 운영자가 **명시적으로 오탐이라고
 * 신고한 건만** 오탐으로 센다. 아무 표시 없는 승인은 오탐이 아니라 **표본이 아니다** —
 * "모델이 틀렸다"가 아니라 "운영자가 말하지 않았다"이기 때문이다.
 *
 * 대가는 표본이 준다는 것이고, 그 대가는 윌슨 하한(K-2)이 받는다.
 */
export type RollbackSample = 'CAUGHT' | 'EXPLICIT_FALSE_POSITIVE' | 'NOT_SCORED';

export function classifyForRollback(r: LabeledReview): RollbackSample {
  const outcome = classifyReview(r);
  // 반려·철회 = 운영자가 위반을 확정했다. 명시적 신호다
  if (outcome === 'TRUE_POSITIVE') return 'CAUGHT';
  // 승인하면서 "지적은 타당했다"를 눌렀다 = 이것도 명시적 신호다
  if (outcome === 'MINOR') return 'CAUGHT';
  // **여기가 핵심**: 지표에서 오탐으로 세는 건 중, 운영자가 실제로 오탐이라고
  // 누른 것만 남긴다. 무응답(null)은 승인됐어도 표본이 아니다.
  if (outcome === 'FALSE_POSITIVE') {
    return r.findingsValid === false ? 'EXPLICIT_FALSE_POSITIVE' : 'NOT_SCORED';
  }
  return 'NOT_SCORED';
}

export interface RollbackStatus {
  /** 격하 판정의 표본이 된 건수 (명시적 신호가 있는 건만) */
  scored: number;
  /** 학생이 잡은 진짜 위반 */
  caught: number;
  /** 운영자가 **명시적으로 신고한** 오탐 */
  falsePositives: number;
  /** 순이익 = caught − λ × falsePositives */
  netValue: number;
  /**
   * 표본이 적을 때 쓰는 **오탐률의 95% 하한**. 손익분기(1/(1+λ))를 넘으면 격하한다.
   * 표본이 창의 절반을 넘으면 순이익 규칙이 대신하므로 참고값이 된다.
   */
  falsePositiveRateLowerBound: number;
  /** 어느 규칙이 판정했는가 — 화면과 알림이 이유를 말할 수 있어야 한다 */
  basis: 'net-value' | 'wilson' | 'insufficient';
  /**
   * 지금 꺼야 하는가.
   *
   * **표본이 모자라면 끄지 않는다.** 3건에서 오탐 1건이 나왔다고 끄면 그것은 측정이
   * 아니라 반사신경이다 — 채택을 128건으로 정해 놓고 폐기를 3건으로 정할 수는 없다.
   * 다만 **명백한 신호는 25건을 기다리지 않는다**(K-2, 윌슨 하한).
   */
  shouldRollback: boolean;
  /** 사람이 읽을 한 줄 — 화면과 알림이 같은 문장을 쓴다 */
  summary: string;
}

/**
 * **학생이 낸 소견에 한정해** 순이익을 센다.
 *
 * 규칙·2차 AI가 낸 소견은 세지 않는다 — 여기서 답하려는 질문이 "학생을 계속 켜 둘
 * 것인가"이기 때문이다. 규칙의 오탐까지 합쳐 세면 규칙이 나쁜 날 학생이 꺼진다.
 * 출처를 나눠 둔 것(`Finding.source = 'student'`)이 여기서 값을 한다.
 *
 * 판정은 표본 크기에 따라 두 규칙으로 갈린다 (11차 K-2):
 *
 * | 표본 | 규칙 | 왜 |
 * |---|---|---|
 * | 창의 절반 이상 (25건~) | 순이익 < 0 | 채택선과 같은 공식 |
 * | 5 ~ 24건 | 오탐률의 95% 하한 > 1/(1+λ) | 출시 직후에도 명백한 신호는 잡는다 |
 * | 5건 미만 | 판정하지 않는다 | 한 건으로는 모델과 리포트가 안 갈린다 |
 *
 * 두 규칙은 사실 **같은 부등식**이다: `순이익 < 0 ⟺ 오탐률 > 1/(1+λ)`.
 * 윌슨은 거기에 표본 보정을 얹은 것뿐이라, 잣대가 둘로 갈라지는 것이 아니다.
 *
 * @param reviews 최신순으로 정렬된 검수 기록 (창 크기만큼만 본다)
 */
export function studentRollbackStatus(
  reviews: LabeledReview[],
  window = ROLLBACK_WINDOW,
  costRatio = ROLLBACK_COST_RATIO,
): RollbackStatus {
  let scored = 0;
  let caught = 0;
  let falsePositives = 0;

  for (const r of reviews.slice(0, window)) {
    // 학생이 아무 말도 안 한 건은 학생의 성적이 아니다
    if (!r.findings.some((f) => f.source === 'student')) continue;
    const sample = classifyForRollback(r);
    if (sample === 'NOT_SCORED') continue;
    scored += 1;
    if (sample === 'CAUGHT') caught += 1;
    else falsePositives += 1;
  }

  const netValue = caught - costRatio * falsePositives;
  // 손익분기 오탐률 — 순이익 0이 되는 지점. λ=4 면 20%
  const breakEven = 1 / (1 + costRatio);
  const lower = wilsonLowerBound(falsePositives, scored);

  const half = Math.ceil(window / 2);
  const basis: RollbackStatus['basis'] =
    scored >= half ? 'net-value' : scored >= WILSON_MIN_SAMPLE ? 'wilson' : 'insufficient';
  const shouldRollback =
    basis === 'net-value' ? netValue < 0 : basis === 'wilson' ? lower > breakEven : false;

  const head = `최근 ${scored}건: 학생이 잡은 위반 ${caught} · 명시적 오탐 ${falsePositives}`;
  const summary =
    basis === 'net-value'
      ? `${head} → 순이익 ${netValue >= 0 ? '+' : ''}${netValue}`
      : basis === 'wilson'
        ? `${head} → 오탐률 95% 하한 ${(lower * 100).toFixed(1)}%` +
          ` (손익분기 ${(breakEven * 100).toFixed(0)}%, 표본 ${scored}/${half}건이라 하한으로 판정)`
        : `표본 부족 (${scored}/${WILSON_MIN_SAMPLE}건) — 아직 판단하지 않습니다`;

  return {
    scored,
    caught,
    falsePositives,
    netValue,
    falsePositiveRateLowerBound: lower,
    basis,
    shouldRollback,
    summary,
  };
}
