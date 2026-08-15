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

/**
 * **`shadow` → `enforce`로 올리는 조건** (2026-08-15, 외부 검토 D-2로 갱신).
 *
 * 처음에는 "불일치율이 충분히 낮아질 때까지 지켜본다"로 적었는데 **목적을 착각한
 * 것이었다.** 그림자 모드가 재는 것은 시장이 아니라 **우리 어댑터**다 — 티커 표기,
 * 시간대, 소수점, 구간 경계. 시장의 불일치는 줄어들 성질의 것이 아니라 **목표선 근처
 * 카드에서 늘 일어나는 정상 현상**이고, 그것이 0이 되기를 기다리는 것은 영영 안 올
 * 날을 기다리며 오판정을 구경하는 일이다.
 *
 * ── 조건 ① 어댑터가 멀쩡한가 (검토 지적) ────────────────────────
 * `OBSERVATION_DAYS` 영업일 동안 `SOURCE_ERROR`와 `NO_DATA`가 사실상 0이어야 한다.
 * 이 둘이 **어댑터 고장의 얼굴**이다 — 표기를 못 바꾸면 SOURCE_ERROR, 구간을 잘못
 * 자르면 NO_DATA가 난다. 불일치(DISAGREED)는 여기에 안 들어간다.
 *
 * ── 조건 ② 대조가 성립하는 조합인가 ─────────────────────────────
 * `npm run probe:sources`로 두 소스가 **같은 원천의 중계가 아닌지** 확인한다.
 * 같은 원천이면 enforce로 올려도 자기 확인이라 아무것도 못 잡으면서 판정만 멈출 수 있다.
 *
 * ── 조건 ③ 큐가 감당하는가 (검토 결론에 우리가 더한 것) ──────────
 * 검토는 "불일치율과 무관하게 즉시 올려라"라고 했는데, 여기까지 가면 위험하다.
 * enforce의 불일치는 **자동 판정을 멈추고 사람을 부른다.** 하루 불일치가 운영자 처리
 * 용량을 넘으면 그 장치는 오판정을 막는 것이 아니라 **판정을 통째로 세운다** —
 * 그리고 밀린 카드는 14일 상한에서 전액 환불로 닫힌다. 오판정을 막으려다 정상 카드를
 * 무판정으로 끝내는 것이라, 바꿔치기가 아니라 **더 나쁜 쪽으로의 교환**이다.
 * 운영자 1명 전제에서 `MAX_DAILY_DISAGREEMENTS`를 넘길 것으로 보이면, enforce 이전에
 * 사람을 늘리거나 소스를 고쳐야 한다.
 *
 * 세 조건은 **관측으로 답할 수 있다** — 그림자 모드가 감사 스냅샷에 status를 남기므로
 * 세어 보면 된다. 이 상수들은 그 세는 기준이다.
 */
export const CROSS_CHECK_READINESS = {
  /** 어댑터 안정성을 보는 관측 기간 (영업일) */
  OBSERVATION_DAYS: 7,
  /** 이 기간 동안 허용되는 어댑터 고장 건수 — 0이 목표다 */
  MAX_ADAPTER_FAULTS: 0,
  /** 운영자 1명이 하루에 두 시세를 나란히 놓고 판정할 수 있는 카드 수 (보수적 추정) */
  MAX_DAILY_DISAGREEMENTS: 10,
} as const;

export function resolveCrossCheckMode(
  env: Record<string, string | undefined> = process.env,
): CrossCheckMode {
  const raw = env.CROSS_CHECK_MODE?.trim().toLowerCase();
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return raw;
  return DEFAULT_CROSS_CHECK_MODE;
}

/**
 * **자산군별 판정 원천을 구매자에게 그대로 적는다** (2026-08-15).
 *
 * 지금 두 번째 소스가 있는 자산군은 코인뿐이다. 이걸 감추면 "판정의 신뢰 수준이
 * 자산군마다 다르다"는 사실이 **감사 기록에만 있고 구매자는 못 보는 상태**가 된다 —
 * 정보 비대칭을 없애겠다는 서비스가 스스로 하나를 만드는 셈이다.
 *
 * **다만 "코인은 불안정해서 이중 대조한다"로 적지 않는다.** 그 프레임이 틀렸다:
 *  · 주식은 KRX·NASDAQ이라는 **중앙 거래소가 유일한 진실**이다. 공식 체결가가 있는데
 *    다른 곳의 값을 가져와 대조하는 것은 원천을 흐리는 일이지 정확해지는 일이 아니다
 *  · 코인은 중앙 거래소가 **없다.** 거래소마다 값이 다른 것이 정상인 시장이라
 *    교차 검증이 정확도의 조건이 된다
 * 즉 대조의 유무는 우열이 아니라 **시장 구조의 차이**이고, 문구도 그렇게 적는다.
 *
 * ⚠ 이 문구는 **사실의 기술이지 원칙의 선언이 아니다.** 국내에 두 번째 소스를 붙이면
 * (공공데이터포털 계약) 여기를 함께 고친다 — "주식은 대조가 불필요하다"고 적어 두면
 * 그때 우리가 한 말을 뒤집게 된다.
 */
export const JUDGMENT_BASIS_NOTE: Record<string, string> = {
  KR_EQUITY: 'KRX 공식 체결가(일봉 종가) 기준 단일 판정',
  US_EQUITY: '미국 거래소 공식 체결가(일봉 종가) 기준 단일 판정',
  CRYPTO: '업비트 KRW 일봉 종가 기준 · 복수 거래소(빗썸) 교차 검증',
};

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
