import type { AssetClass, BaseMode } from './constants';
import { judge, type JudgmentResult, type PredictionInput } from './judgment';
import {
  buildMarketSnapshot,
  marketClock,
  MARKET_TIMEZONE,
  nextDateString,
  resolveProvider,
  toMarketDateString,
  type DailyQuote,
  type MarketDataProvider,
  type ProviderRegistry,
  type SecurityStatus,
} from './marketData';
import { isOutsideCalendarCoverage } from './marketCalendar';
import { EQUITY_REGULAR_CLOSE } from './publishReport';
import {
  crossCheckJudgment,
  JudgmentDisagreementError,
  resolveCrossCheckMode,
  type CrossCheckMode,
  type CrossCheckReport,
} from './crossCheck';

// 예측 카드 1건의 판정 파이프라인: 데이터 조회 → 스냅샷 조립 → 판정.
// DB 저장·정산 실행은 호출자(배치 잡) 책임 — 이 모듈은 부수효과 없이 결과만 만든다.
// 배치 흐름·이월 규칙: docs/market-data.md §3

/** 데이터 미도달 등으로 이번 배치에서 판정할 수 없는 상태 (다음 배치로 이월) */
/**
 * **시세 공급자가 응답하지 못했다** — 우리 코드 문제가 아니다 (2026-08-15).
 *
 * 이월(JudgmentDeferredError)과도 다르다: 이월은 "공급자가 정상 응답했는데 그 구간에
 * 데이터가 없다"이고(그날 봉이 아직 안 올라온 정상 상황이 대부분), 이건 **물어보지도
 * 못한 상태**다. 앞은 기다리면 대개 저절로 풀리고, 뒤는 소스가 살아나야 풀린다.
 *
 * 셋을 가르는 이유는 **운영자가 갈 곳이 다르기 때문**이다:
 *   이월  → 아무것도 안 해도 된다 (다음 회차가 다시 본다)
 *   공급자 → 소스 상태를 본다 (KIS 공지·업비트 상태 페이지)
 *   버그  → 로그를 보고 코드를 고친다
 */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly sourceId: string,
    readonly ticker: string,
    readonly cause: unknown,
  ) {
    super(`${sourceId}: ${ticker} 조회 실패 — ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'ProviderUnavailableError';
  }
}

export class JudgmentDeferredError extends Error {
  constructor(
    message: string,
    /**
     * `EMPTY_RANGE`는 DATA_NOT_AVAILABLE의 특수한 갈래다 — **공급자가 200 OK로 빈 배열을
     * 줬다.** 처리는 같지만(이월) **감시가 다르다**: 이건 예외가 나지 않아 공급자 장애
     * 감지(ProviderUnavailableError)에도, 이상값 필터에도 걸리지 않는 **유일하게 조용한
     * 실패**다. 한 장이면 "그날 봉이 아직 안 올라왔다"는 정상이지만, 한 소스에서 무더기로
     * 나면 스펙 변경이나 부분 장애이고 그동안 판정·정산이 통째로 선다.
     *
     * 사유를 나누는 이유는 **문자열 매칭을 피하려는 것**이다. 메시지로 가르면 문구를
     * 다듬는 순간 감시가 조용히 꺼진다.
     */
    readonly reason: 'DEADLINE_NOT_REACHED' | 'DATA_NOT_AVAILABLE' | 'EMPTY_RANGE',
  ) {
    super(message);
    this.name = 'JudgmentDeferredError';
  }
}

export interface JudgeableCard extends Omit<PredictionInput, 'basePrice'> {
  assetClass: AssetClass;
  /** 자산군별 표기: KR 6자리 코드 | US 심볼 | 업비트 마켓코드(KRW-BTC) */
  ticker: string;
  /** 기준가 확정 방식 (publishReport.ts) */
  baseMode: BaseMode;
  /** FIXED_AT_PUBLISH면 필수. PREV_CLOSE_AT_JUDGMENT면 null — 여기서 소급 확정 */
  basePrice: number | null;
  /** 게시 시각 */
  publishedAt: Date;
  /** 검증 시한 */
  deadline: Date;
}

/** 분쟁 시 판정을 재현하기 위한 감사 기록 — Judgment.marketSnapshotJson에 저장 */
export interface JudgmentAudit {
  dataSource: string;
  fetchedAt: string;
  quotes: DailyQuote[];
  securityStatus: SecurityStatus;
  /**
   * 두 번째 소스가 같은 결론에 이르렀는가 (domain/crossCheck).
   *
   * **합의했을 때도 남긴다.** 이의가 들어온 뒤 되물어야 하는 것은 "그 판정에 증인이
   * 있었는가"이고, 없었다는 사실 자체가 답의 일부다. 교차검증을 켜기 전에 나간 판정은
   * 이 칸이 없으므로(undefined) 시점 구분도 여기서 된다.
   */
  crossCheck?: CrossCheckReport;
}

export interface PipelineResult {
  result: JudgmentResult;
  audit: JudgmentAudit;
  /** PREV_CLOSE_AT_JUDGMENT 카드에서 소급 확정된 기준가 — 배치가 카드에 기록한다 */
  resolvedBasePrice: number | null;
}

/** 기준가 소급 확정용: 게시일 직전 거래일 종가를 찾기 위한 조회 여유 (연휴 대비) */
const BASE_LOOKBACK_DAYS = 10;

/**
 * 하루 만에 이 폭을 넘는 종가 변화는 **데이터 사고로 본다** — 판정하지 않고 이월한다.
 *
 * ── 왜 필요한가 ──────────────────────────────────────────────
 * 판정은 게시일~시한의 종가 **극값**이 목표를 넘었는지로 정한다. 공급자가 하루치를
 * 잘못 주면(0, 자릿수 오류, 통화 혼동) **그 한 줄로 카드가 적중 판정**되고 구매자는
 * 환불을 못 받는다. 권리 사건은 앵커 방식이 이미 막지만(domain/corporateAction),
 * 그것은 **과거 종가가 소급해 바뀌는 것**을 잡는 장치라 하루짜리 튀는 값은 못 거른다.
 *
 * ── 값의 근거 (scripts/calibrateQuoteOutlier.ts, 실일봉 2019~2023) ──
 * σ 배수로 잡으려 했는데 **자산군마다 진짜 급변의 크기가 달라** 하나로 덮이지 않았다:
 * 국내 최대 6.9σ · 미국 7.1σ · 코인 **16.4σ**(2020-03-12 −33%, 2023-07-13 XRP +69%).
 * 그래서 자산군별 절대 폭으로 둔다.
 *
 *   · 국내 30% — **거래소 가격제한폭**이다. 규칙이라 고를 필요가 없고, 실측
 *     일봉 6,672개에서 초과가 **0건**으로 확인됐다(최대 +19.4%)
 *   · 미국 60% — 상한 제도가 없다. 실측 최대 +24.4%(NVDA 2023-05-25)의 2.5배
 *   · 코인 150% — 실측 최대 +68.6%(XRP)의 2.2배. 24시간 거래라 폭이 가장 크다
 *
 * ── 무엇을 잡고 무엇을 놓치나 ────────────────────────────────
 * 이것은 **"물리적으로 불가능한 값"** 필터지 "놀라운 값" 필터가 아니다. 실제 사고는
 * 대부분 자릿수 단위(0, ×10, 통화 혼동 ×1300)라 이 문턱이면 전부 걸린다. 반대로
 * 5% 어긋난 값 같은 미묘한 오류는 **통과한다** — 그건 이 장치로 잡을 수 없고,
 * 잡으려 문턱을 조이면 진짜 급변이 무더기로 이월돼 운영 부담만 는다.
 */
export const IMPLAUSIBLE_DAILY_MOVE: Record<AssetClass, number> = {
  KR_EQUITY: 0.3,
  US_EQUITY: 0.6,
  CRYPTO: 1.5,
};

/**
 * 판정 구간에서 **불가능한 변동폭**을 가진 첫 일봉을 찾는다 (없으면 null).
 * 기준가가 있으면 그것을 첫 비교 대상으로 삼는다 — 구간 첫 종가가 튄 경우도 잡으려면
 * 앞이 있어야 하기 때문이다.
 */
function findImplausibleBar(
  assetClass: AssetClass,
  basePrice: number | null,
  quotes: DailyQuote[],
): { date: string; close: number; prev: number; movePct: number } | null {
  const limit = IMPLAUSIBLE_DAILY_MOVE[assetClass];
  let prev = basePrice != null && basePrice > 0 ? basePrice : null;
  for (const q of quotes) {
    if (!(q.close > 0)) {
      return { date: q.date, close: q.close, prev: prev ?? 0, movePct: -1 };
    }
    if (prev !== null) {
      const move = q.close / prev - 1;
      if (Math.abs(move) > limit) {
        return { date: q.date, close: q.close, prev, movePct: move };
      }
    }
    prev = q.close;
  }
  return null;
}

/**
 * 두 번째 소스로 판정을 다시 매겨 결론을 대조한다. **조회 실패는 삼킨다** —
 * 교차검증은 판정의 보조 장치라, 보조가 죽었다고 본체가 멈추면 안 된다.
 * (주 소스의 실패는 정반대로 다룬다 — ProviderUnavailableError로 판정 자체를 멈춘다)
 */
async function runCrossCheck(
  card: JudgeableCard,
  basePrice: number,
  result: JudgmentResult,
  windowQuotes: DailyQuote[],
  deadlineDate: string,
  secondary: MarketDataProvider,
): Promise<CrossCheckReport> {
  const base = {
    sourceId: secondary.sourceId,
    primaryOutcome: result.outcome,
    secondaryOutcome: null,
    maxCloseDeviation: null,
  };
  let secondaryQuotes: DailyQuote[];
  try {
    // 주 소스가 **실제로 판정에 쓴 구간**을 그대로 묻는다 — 이름뿐인 게시일이 아니라
    // 기준봉 제외까지 끝난 뒤의 첫 날짜여야 두 판정이 같은 질문에 답한다
    secondaryQuotes = await secondary.getDailyQuotes(
      card.ticker,
      windowQuotes[0].date,
      deadlineDate,
    );
  } catch (e) {
    return {
      ...base,
      status: 'SOURCE_ERROR',
      detail: e instanceof Error ? e.message : String(e),
    };
  }

  return crossCheckJudgment({
    prediction: { ...card, basePrice },
    primaryResult: result,
    primaryQuotes: windowQuotes,
    secondaryQuotes,
    secondarySourceId: secondary.sourceId,
    deadlineDate,
  });
}

/**
 * 카드 1건을 판정한다.
 * @throws JudgmentDeferredError 시한 미도래 또는 시한 당일 데이터 미공개 시 (배치 이월)
 * @throws JudgmentDisagreementError 교차검증(enforce)이 결론을 뒤집었을 때 (수동 판정 큐)
 */
export async function runJudgment(
  card: JudgeableCard,
  provider: MarketDataProvider,
  now = new Date(),
  /** 판정 교차검증용 두 번째 소스 (없으면 검증하지 않고 그 사실을 감사에 남긴다) */
  secondary?: MarketDataProvider,
  mode: CrossCheckMode = resolveCrossCheckMode(),
): Promise<PipelineResult> {
  if (now < card.deadline) {
    throw new JudgmentDeferredError(
      `검증 시한(${card.deadline.toISOString()}) 미도래`,
      'DEADLINE_NOT_REACHED',
    );
  }

  const retroactive = card.baseMode !== 'FIXED_AT_PUBLISH';
  // 거래일 날짜는 자산군의 시간대 기준 (미국주식 시한이 KST 새벽이면 ET 전일로 환산)
  const publishDate = toMarketDateString(card.publishedAt, card.assetClass);
  const deadlineDate = toMarketDateString(card.deadline, card.assetClass);

  // **달력이 책임지지 않는 날짜는 판정하지 않는다.**
  // 구간 밖에서 이 달력은 "휴일이 없다"고 답한다 — 연휴에 판정을 시도하고, 늦은 마감을
  // 모른 채 장중에 판정한다. 둘 다 조용히 틀리는 방향이라 이월이 낫다:
  // 판정이 늦는 것은 되돌릴 수 있지만 잘못된 판정은 정산까지 흘러가 되돌릴 수 없다.
  if (isOutsideCalendarCoverage(card.assetClass, deadlineDate)) {
    throw new JudgmentDeferredError(
      `${card.ticker}: 시한 ${deadlineDate}가 거래일 달력 범위 밖이라 판정을 보류합니다 — 달력을 갱신해야 합니다`,
      'DATA_NOT_AVAILABLE',
    );
  }
  // 직전 종가 소급 카드는 게시일 이전 종가도 필요하므로 조회 범위를 과거로 넓힌다
  const from =
    card.baseMode === 'PREV_CLOSE_AT_JUDGMENT'
      ? toMarketDateString(
          new Date(card.publishedAt.getTime() - BASE_LOOKBACK_DAYS * 86_400_000),
          card.assetClass,
        )
      : publishDate;

  // **공급자가 던진 것과 우리가 던진 것을 여기서 가른다** (2026-08-15).
  //
  // 지금까지 둘이 같은 통에 담겨 `[버그] 판정 오류 — 코드 확인 필요`로 나갔다.
  // 그런데 이 통에 더 흔하게 들어오는 것은 **공급자 장애**(토큰 만료·HTTP 5xx·rt_cd
  // 실패)이고, 그건 기다리면 낫고 우리 코드를 봐도 나올 것이 없다.
  // 알림이 운영자를 **틀린 곳으로 보내고 있었다.**
  //
  // 호출을 감싸는 방식을 쓴 이유: 어댑터마다 에러 모양이 달라 메시지 문자열로 가르면
  // 공급자를 추가할 때마다 조용히 어긋난다. **경계 하나만** 지키면 그 안에서 나온 것은
  // 정의상 전부 공급자 몫이다.
  let quotes: DailyQuote[];
  let securityStatus: SecurityStatus;
  try {
    [quotes, securityStatus] = await Promise.all([
      provider.getDailyQuotes(card.ticker, from, deadlineDate),
      provider.getSecurityStatus(card.ticker, deadlineDate),
    ]);
  } catch (e) {
    throw new ProviderUnavailableError(provider.sourceId, card.ticker, e);
  }

  const normalStatus = !securityStatus.delisted && !securityStatus.halted;
  // 판정 대상 구간은 게시일~시한. 소급 조회분(게시일 이전)은 기준가 계산에만 쓴다.
  let windowQuotes = quotes.filter((q) => q.date >= publishDate);
  let basePrice = card.basePrice;

  if (normalStatus) {
    if (card.baseMode === 'PREV_CLOSE_AT_JUDGMENT') {
      // 개장 전 게시 카드: 기준가 = 게시일 직전 거래일 종가 (게시 시점엔 D+1 지연으로 알 수 없던 값)
      const before = quotes.filter((q) => q.date < publishDate);
      basePrice = before.length > 0 ? before[before.length - 1].close : null;
      if (basePrice === null) {
        throw new JudgmentDeferredError(
          `${card.ticker}: 게시일(${publishDate}) 직전 종가를 찾지 못해 기준가 소급 확정 불가`,
          'DATA_NOT_AVAILABLE',
        );
      }
    } else if (card.baseMode === 'DAY_CLOSE_AT_JUDGMENT') {
      // 장중·장후·주말 게시 카드: 기준가 = 게시 이후 첫 정규장 종가.
      // 정규장 마감 후 게시라면 그날 종가는 이미 공개된 과거이므로(애프터마켓·시간외
      // 정보 가로채기 가능) 기준일을 다음 거래일로 굴린다.
      const closeTime = EQUITY_REGULAR_CLOSE[card.assetClass as 'KR_EQUITY' | 'US_EQUITY'];
      const clock = marketClock(card.publishedAt, MARKET_TIMEZONE[card.assetClass]);
      const baseFromDate = clock.time <= closeTime ? publishDate : nextDateString(publishDate);
      const baseCandle = windowQuotes.find((q) => q.date >= baseFromDate);
      if (!baseCandle) {
        throw new JudgmentDeferredError(
          `${card.ticker}: ${baseFromDate} 이후 첫 종가를 찾지 못해 기준가 소급 확정 불가`,
          'DATA_NOT_AVAILABLE',
        );
      }
      basePrice = baseCandle.close;
      windowQuotes = windowQuotes.filter((q) => q.date > baseCandle.date);
    }

    // **시한 이후 날짜는 판정 구간이 아니다** (2026-08-16).
    //
    // 조회는 `[from, deadlineDate]`로 하지만 공급자가 범위를 무시하고 최근 데이터를
    // 주면 시한 이후 일봉이 섞여 들어온다. 그러면 아래 "구간 시세 전무" 검사가
    // **통과해 버리고**, 정작 `buildMarketSnapshot`은 시한까지로 다시 걸러 빈 구간을
    // 받는다 — 극값도 시한 종가도 없는 스냅샷이 `judge()`에 들어가 **AMBIGUOUS로
    // 즉시 닫힌다.** 그 결말은 전액 환불·리서처 0원인데, 원인은 공급자 응답이지
    // 예측이 아니다. 게다가 AMBIGUOUS는 상한 경로를 안 거쳐 **보상 판별에도 안 걸리고
    // 재시도도 없다** — 다음 회차면 정상화될 수 있는 사고인데 한 번에 끝나 버린다.
    //
    // 여기서 미리 걸러 두면 아래 검사가 EMPTY_RANGE로 잡아 이월 → 재시도 → (그래도
    // 안 되면) 14일 상한으로 이어진다. **스냅샷이 쓰는 구간과 검사가 보는 구간을
    // 같게 만드는 것**이 요점이고, 이상값 필터도 같은 이유로 이 구간만 봐야 한다.
    windowQuotes = windowQuotes.filter((q) => q.date <= deadlineDate);

    // 정상 종목인데 판정 구간 시세가 전무하면 소스 지연(D+1) 가능성 — 판정하지 않고 이월.
    // 공휴일에 게시된 당일 카드도 여기로 오며, 이월 한도 초과 시 수동 보류 큐로 간다.
    if (windowQuotes.length === 0) {
      throw new JudgmentDeferredError(
        `${card.ticker}: ${publishDate}~${deadlineDate} 판정 구간 시세 없음 (소스 지연 가능)`,
        'EMPTY_RANGE',
      );
    }

    // **불가능한 일봉이 섞여 있으면 판정하지 않는다** (IMPLAUSIBLE_DAILY_MOVE).
    // 판정은 종가 극값을 보므로 튀는 값 한 줄이 곧 오적중이고, 그러면 구매자가 환불을
    // 못 받는다. 되돌릴 수 없는 방향이라 이월하고 사람이 보게 남긴다.
    const bad = findImplausibleBar(card.assetClass, basePrice, windowQuotes);
    if (bad) {
      throw new JudgmentDeferredError(
        `${card.ticker}: ${bad.date} 종가 ${bad.close}이 직전값 ${bad.prev} 대비 ${(bad.movePct * 100).toFixed(0)}% 변동 — 시세 오류로 보고 판정을 보류합니다`,
        'DATA_NOT_AVAILABLE',
      );
    }
  }

  const snapshot = buildMarketSnapshot(windowQuotes, securityStatus, deadlineDate);
  // basePrice가 null인 채 남는 경우(거래정지·상폐 소급 카드)는 상태 기반 UNDECIDABLE로 처리됨
  const result = judge({ ...card, basePrice: basePrice ?? 0 }, snapshot);

  // ── 두 번째 증인에게 같은 질문을 한다 (domain/crossCheck) ──────────────
  // 판정 불가(UNDECIDABLE)는 묻지 않는다: 그 결론의 근거는 종목 상태나 결측이고,
  // 둘 다 가격만 아는 두 번째 소스가 답할 수 있는 질문이 아니다. 그리고 판정 불가는
  // **전액 환불**로 끝나 잘못돼도 돈이 잘못된 사람에게 가지 않는다 — 이 장치가 지키려는
  // 것은 "적중인데 실패로", "실패인데 적중으로" 두 방향뿐이다.
  let crossCheck: CrossCheckReport | undefined;
  if (mode !== 'off' && result.outcome !== 'UNDECIDABLE' && windowQuotes.length > 0) {
    crossCheck = secondary
      ? await runCrossCheck(
          card,
          basePrice ?? 0,
          result,
          windowQuotes,
          deadlineDate,
          secondary,
        )
      : {
          status: 'NO_SECONDARY',
          sourceId: null,
          primaryOutcome: result.outcome,
          secondaryOutcome: null,
          maxCloseDeviation: null,
        };
  }

  const audit: JudgmentAudit = {
    dataSource: provider.sourceId,
    fetchedAt: now.toISOString(),
    quotes,
    securityStatus,
    ...(crossCheck ? { crossCheck } : {}),
  };

  // **그림자 모드에서는 기록만 하고 판정을 막지 않는다.** 검증되지 않은 두 번째 소스에
  // 정산을 멈출 권한을 주면, 티커 표기 하나가 어긋난 날 그 자산군 전체가 보류로 간다
  if (crossCheck?.status === 'DISAGREED') {
    if (mode === 'enforce') throw new JudgmentDisagreementError(crossCheck);
    console.warn(
      `[교차검증·그림자] ${card.ticker}: 주 ${crossCheck.primaryOutcome} / ` +
        `${crossCheck.sourceId} ${crossCheck.secondaryOutcome} — 판정은 주 소스로 진행합니다`,
    );
  }

  return { result, resolvedBasePrice: retroactive ? basePrice : null, audit };
}

/**
 * 배치 잡 진입점: 자산군에 맞는 공급자를 레지스트리에서 선택해 판정.
 *
 * 두 번째 레지스트리는 **자산군이 비어 있어도 된다** — resolveProvider가 아니라 직접
 * 꺼내는 이유가 그것이다. 주 소스는 없으면 판정이 성립하지 않아 던져야 맞지만,
 * 두 번째 소스는 없는 것이 정상 상태다(계약 전 자산군).
 */
export async function runJudgmentFromRegistry(
  card: JudgeableCard,
  registry: ProviderRegistry,
  now = new Date(),
  secondaryRegistry?: ProviderRegistry,
  mode: CrossCheckMode = resolveCrossCheckMode(),
): Promise<PipelineResult> {
  return runJudgment(
    card,
    resolveProvider(registry, card.assetClass),
    now,
    secondaryRegistry?.[card.assetClass],
    mode,
  );
}
