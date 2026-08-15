import type { Outcome } from './constants';
import { buildMarketSnapshot, type DailyQuote, type SecurityStatus } from './marketData';
import { judge, type JudgmentResult, type PredictionInput } from './judgment';

// 판정 교차검증 — **두 번째 소스가 같은 결론에 이르는가.**
//
// ── 무엇을 막는 장치인가 ────────────────────────────────────────
// IMPLAUSIBLE_DAILY_MOVE(judgmentPipeline)는 **불가능한 값**을 잡는다 — 0, 자릿수 오류,
// 통화 혼동. 하지만 문서에 적어 둔 대로 "5% 어긋난 값 같은 미묘한 오류는 통과한다".
// 그 구멍으로 들어온 값은 **조용히 정산까지 흘러간다**: 잘못 적중이면 구매자가 환불을
// 못 받고, 잘못 실패면 리서처가 대금을 못 받는다. 지금 그것을 발견하는 경로는
// **사람의 이의 제기뿐**이고, 금액이 작거나 당사자가 모르면 영원히 발견되지 않는다.
//
// ── 왜 가격이 아니라 **판정**을 대조하는가 ──────────────────────
// 처음 안은 "판정 시점의 기준 종가 1개를 두 번째 소스에서 받아 오차 X% 이내인지 본다"
// 였다. 두 곳이 틀렸다:
//
//  ① **틀린 값을 본다.** 판정은 시한 종가만이 아니라 **구간 종가의 극값**으로 정해진다.
//     구간 한가운데 하루가 튀어서 생기는 **잘못된 적중**이 더 나쁜 방향인데(구매자가
//     환불을 못 받는다), 시한 종가만 대조하면 그것을 통째로 놓친다.
//  ② **비용 계산이 틀렸다.** 어차피 `getDailyQuotes(ticker, from, to)`는 구간 하나가
//     **호출 1회**다. 하루치만 받는다고 싸지지 않는다 — 그래서 **구간 전체**를 받아
//     판정을 통째로 다시 매기는 쪽이 같은 값에 훨씬 강하다.
//
// 그리고 값이 아니라 결론을 보면 **문턱을 고를 필요가 사라진다.** 종가가 0.3% 어긋난
// 것이 문제인지 아닌지는 그 자체로 답할 수 없다 — 목표선에서 멀면 아무 일도 아니고,
// 목표선 위라면 판정이 뒤집힌다. **"판정이 뒤집히는가"가 정확히 그 질문**이라,
// 임의의 허용 오차(1%? 0.5%?)를 튜닝하는 일 자체가 없어진다.
//
// 부수 효과로 코인의 난제도 풀린다: 업비트와 빗썸은 **원래 값이 다르다**(거래소가
// 다르므로). 가격 대조는 그 정상적인 차이를 계속 사고로 신고하지만, 결론 대조는
// 목표선 근처에서만 갈린다 — 그리고 목표선 근처야말로 사람이 봐야 하는 자리다.
//
// ── 합의해도 기록한다 ───────────────────────────────────────────
// 결론이 같아도 `maxCloseDeviation`(같은 날짜 종가의 최대 상대 괴리)을 남긴다.
// 이의가 들어왔을 때 "그 판정에 두 번째 증인이 있었는가, 둘이 얼마나 붙어 있었는가"를
// 되물을 수 있어야 하고, 소스가 서서히 어긋나는 것은 그 값이 커지는 모습으로만 보인다.

/**
 * 교차검증 운용 모드.
 *
 * **`shadow`가 기본값인 이유가 이 설계에서 가장 중요하다.** 두 번째 소스가 틀리면
 * 이 장치는 **모든 판정을 멈춘다** — 티커 표기 하나만 어긋나도 그 자산군 전체가 보류로
 * 간다. 검증되지 않은 소스에 정산을 멈출 권한을 주는 셈이라, 새 소스는 반드시
 * 그림자로 먼저 돈다: 결론을 기록만 하고 판정은 종전대로 나간다. 불일치율이
 * 실측으로 납득될 때 `enforce`로 올린다.
 *
 * 되돌릴 때도 같은 이유로 코드 배포가 아니라 환경 변수여야 한다 — 소스가 밤에 망가지면
 * 배포를 기다릴 수 없다.
 */
export type CrossCheckMode = 'off' | 'shadow' | 'enforce';

export const DEFAULT_CROSS_CHECK_MODE: CrossCheckMode = 'shadow';

export function resolveCrossCheckMode(
  env: Record<string, string | undefined> = process.env,
): CrossCheckMode {
  const raw = env.CROSS_CHECK_MODE?.trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  return DEFAULT_CROSS_CHECK_MODE;
}

export type CrossCheckStatus =
  /** 두 소스의 판정이 같다 */
  | 'AGREED'
  /** 두 소스의 판정이 다르다 — enforce 모드면 판정하지 않는다 */
  | 'DISAGREED'
  /** 이 자산군에 두 번째 소스가 없다 (계약 전) */
  | 'NO_SECONDARY'
  /** 두 번째 소스가 이 구간을 덮지 못한다 — **불일치가 아니다** */
  | 'NO_DATA'
  /** 두 번째 소스 조회 자체가 실패했다 — **불일치가 아니다** */
  | 'SOURCE_ERROR';

export interface CrossCheckReport {
  status: CrossCheckStatus;
  /** 두 번째 소스 식별자 (없으면 null) */
  sourceId: string | null;
  primaryOutcome: Outcome | null;
  secondaryOutcome: Outcome | null;
  /**
   * 같은 날짜에 두 소스가 준 종가의 **최대 상대 괴리** (0.01 = 1%).
   * 결론이 같아도 남긴다 — 소스가 서서히 어긋나는 것은 이 값으로만 보인다.
   * 겹치는 날짜가 없으면 null.
   */
  maxCloseDeviation: number | null;
  detail?: string;
}

/**
 * 교차검증이 결론을 뒤집었다 — **판정하지 않는다.**
 *
 * 이월(JudgmentDeferredError)과 다르게 다뤄야 하는 이유는 **저절로 낫지 않기 때문**이다.
 * 이월은 기다리면 데이터가 올라오지만, 두 소스가 다른 답을 내는 상태는 다음 회차에도
 * 똑같다. 백오프를 태워 14일 상한까지 굴리면 그동안 에스크로만 묶이고 결말은
 * "판정 불가·전액 환불"로 정해져 있다 — **맞혔을지도 모르는 리서처가 0점을 받는다.**
 *
 * 그래서 배치는 이 오류를 받는 즉시 카드를 **수동 판정 큐로 올린다**(manualJudgmentOnly).
 * 사람이 두 시세를 나란히 놓고 판정하는 것이 유일하게 답이 있는 경로다.
 */
export class JudgmentDisagreementError extends Error {
  constructor(readonly report: CrossCheckReport) {
    super(
      `시세 소스 간 판정 불일치 — 주 소스 ${report.primaryOutcome} / ` +
        `${report.sourceId} ${report.secondaryOutcome}` +
        (report.maxCloseDeviation !== null
          ? ` (같은 날짜 종가 최대 괴리 ${(report.maxCloseDeviation * 100).toFixed(2)}%)`
          : ''),
    );
    this.name = 'JudgmentDisagreementError';
  }
}

/** 같은 날짜를 가진 종가끼리 비교해 최대 상대 괴리를 낸다 (겹치는 날짜가 없으면 null) */
export function maxCloseDeviation(a: DailyQuote[], b: DailyQuote[]): number | null {
  const byDate = new Map(b.map((q) => [q.date, q.close]));
  let worst: number | null = null;
  for (const q of a) {
    const other = byDate.get(q.date);
    if (other === undefined || !(q.close > 0)) continue;
    const dev = Math.abs(other - q.close) / q.close;
    if (worst === null || dev > worst) worst = dev;
  }
  return worst;
}

export interface CrossCheckInput {
  /** 판정 대상 — 주 소스 판정에 쓴 것과 **같은** 사양·기준가여야 한다 */
  prediction: PredictionInput;
  primaryResult: JudgmentResult;
  primaryQuotes: DailyQuote[];
  secondaryQuotes: DailyQuote[];
  secondarySourceId: string;
  deadlineDate: string;
}

/**
 * 두 번째 소스의 일봉으로 **같은 판정을 다시 매겨** 결론을 대조한다 (순수 함수).
 *
 * 종목 상태(거래정지·상폐)는 주 소스의 것을 그대로 쓴다 — 두 번째 소스가 상태를 주지
 * 않는 경우가 흔하고, 여기서 묻는 것은 **가격이 목표를 넘었는가** 하나다. 상태 불일치는
 * 성격이 다른 문제라 이 장치에 얹지 않는다.
 *
 * 기준가도 주 소스에서 확정된 값을 그대로 쓴다. 소급 확정 카드의 기준가까지 두 번째
 * 소스로 다시 유도하면 "덮지 못하는 과거 구간" 때문에 불일치가 쏟아지는데, 그것은
 * 데이터 사고가 아니라 **소스의 조회 범위 차이**다.
 */
export function crossCheckJudgment(input: CrossCheckInput): CrossCheckReport {
  const deviation = maxCloseDeviation(input.primaryQuotes, input.secondaryQuotes);
  const base: Omit<CrossCheckReport, 'status'> = {
    sourceId: input.secondarySourceId,
    primaryOutcome: input.primaryResult.outcome,
    secondaryOutcome: null,
    maxCloseDeviation: deviation,
  };

  if (input.secondaryQuotes.length === 0) {
    return { ...base, status: 'NO_DATA', detail: '두 번째 소스에 이 구간 시세가 없습니다' };
  }

  // 상태는 주 소스 판정이 이미 반영했다 — 여기서는 정상 거래를 가정하고 가격만 묻는다
  const normal: SecurityStatus = { delisted: false, halted: false };
  const snapshot = buildMarketSnapshot(input.secondaryQuotes, normal, input.deadlineDate);
  const secondary = judge(input.prediction, snapshot);

  // **판정 불가는 반대 의견이 아니다.** 두 번째 소스가 구간을 부분적으로만 덮으면
  // AMBIGUOUS가 나오는데, 그것은 "다르게 판정했다"가 아니라 "답하지 못했다"다.
  // 이것을 불일치로 세면 커버리지가 얕은 소스가 판정을 통째로 멈춘다.
  if (secondary.outcome === 'UNDECIDABLE') {
    return {
      ...base,
      status: 'NO_DATA',
      secondaryOutcome: secondary.outcome,
      detail: `두 번째 소스가 판정하지 못했습니다 (${secondary.undecidableReason})`,
    };
  }

  // 주 소스가 판정 불가면 대조할 결론이 없다 — 그 경로는 상태(정지·상폐)나 결측이
  // 이유이고 둘 다 두 번째 소스가 답할 수 있는 질문이 아니다
  if (input.primaryResult.outcome === 'UNDECIDABLE') {
    return { ...base, status: 'NO_DATA', secondaryOutcome: secondary.outcome };
  }

  return {
    ...base,
    status: secondary.outcome === input.primaryResult.outcome ? 'AGREED' : 'DISAGREED',
    secondaryOutcome: secondary.outcome,
  };
}
