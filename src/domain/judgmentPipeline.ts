import type { AssetClass, BaseMode } from './constants';
import { judge, type JudgmentResult, type PredictionInput } from './judgment';
import {
  buildMarketSnapshot,
  resolveProvider,
  toMarketDateString,
  type DailyQuote,
  type MarketDataProvider,
  type ProviderRegistry,
  type SecurityStatus,
} from './marketData';

// 예측 카드 1건의 판정 파이프라인: 데이터 조회 → 스냅샷 조립 → 판정.
// DB 저장·정산 실행은 호출자(배치 잡) 책임 — 이 모듈은 부수효과 없이 결과만 만든다.
// 배치 흐름·이월 규칙: docs/market-data.md §3

/** 데이터 미도달 등으로 이번 배치에서 판정할 수 없는 상태 (다음 배치로 이월) */
export class JudgmentDeferredError extends Error {
  constructor(
    message: string,
    readonly reason: 'DEADLINE_NOT_REACHED' | 'DATA_NOT_AVAILABLE',
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
 * 카드 1건을 판정한다.
 * @throws JudgmentDeferredError 시한 미도래 또는 시한 당일 데이터 미공개 시 (배치 이월)
 */
export async function runJudgment(
  card: JudgeableCard,
  provider: MarketDataProvider,
  now = new Date(),
): Promise<PipelineResult> {
  if (now < card.deadline) {
    throw new JudgmentDeferredError(
      `검증 시한(${card.deadline.toISOString()}) 미도래`,
      'DEADLINE_NOT_REACHED',
    );
  }

  const retroactiveBase = card.baseMode === 'PREV_CLOSE_AT_JUDGMENT';
  // 거래일 날짜는 자산군의 시간대 기준 (미국주식 시한이 KST 새벽이면 ET 전일로 환산)
  const publishDate = toMarketDateString(card.publishedAt, card.assetClass);
  const deadlineDate = toMarketDateString(card.deadline, card.assetClass);
  // 소급 확정 카드는 게시일 직전 종가도 필요하므로 조회 범위를 과거로 넓힌다
  const from = retroactiveBase
    ? toMarketDateString(
        new Date(card.publishedAt.getTime() - BASE_LOOKBACK_DAYS * 86_400_000),
        card.assetClass,
      )
    : publishDate;

  const [quotes, securityStatus] = await Promise.all([
    provider.getDailyQuotes(card.ticker, from, deadlineDate),
    provider.getSecurityStatus(card.ticker, deadlineDate),
  ]);

  // 판정 대상 구간은 게시일~시한. 소급 조회분(게시일 이전)은 기준가 계산에만 쓴다.
  const windowQuotes = quotes.filter((q) => q.date >= publishDate);
  const normalStatus = !securityStatus.delisted && !securityStatus.halted;

  // 정상 종목인데 판정 구간 시세가 전무하면 소스 지연(D+1) 가능성 — 판정하지 않고 이월.
  // KR 당일 카드가 공휴일에 게시된 경우도 여기로 오며, 이월 한도 초과 시 수동 보류 큐로 간다.
  if (normalStatus && windowQuotes.length === 0) {
    throw new JudgmentDeferredError(
      `${card.ticker}: ${publishDate}~${deadlineDate} 시세 데이터 없음 (소스 지연 가능)`,
      'DATA_NOT_AVAILABLE',
    );
  }

  // 기준가 확정: 소급 카드는 게시일 직전 거래일 종가 (게시 시점엔 D+1 지연으로 알 수 없던 값)
  let basePrice = card.basePrice;
  if (retroactiveBase && normalStatus) {
    const before = quotes.filter((q) => q.date < publishDate);
    basePrice = before.length > 0 ? before[before.length - 1].close : null;
    if (basePrice === null) {
      throw new JudgmentDeferredError(
        `${card.ticker}: 게시일(${publishDate}) 직전 종가를 찾지 못해 기준가 소급 확정 불가`,
        'DATA_NOT_AVAILABLE',
      );
    }
  }

  const snapshot = buildMarketSnapshot(windowQuotes, securityStatus, deadlineDate);
  // basePrice가 null인 채 남는 경우(거래정지·상폐 소급 카드)는 상태 기반 UNDECIDABLE로 처리됨
  const result = judge({ ...card, basePrice: basePrice ?? 0 }, snapshot);
  return {
    result,
    resolvedBasePrice: retroactiveBase ? basePrice : null,
    audit: {
      dataSource: provider.sourceId,
      fetchedAt: now.toISOString(),
      quotes,
      securityStatus,
    },
  };
}

/** 배치 잡 진입점: 자산군에 맞는 공급자를 레지스트리에서 선택해 판정 */
export async function runJudgmentFromRegistry(
  card: JudgeableCard,
  registry: ProviderRegistry,
  now = new Date(),
): Promise<PipelineResult> {
  return runJudgment(card, resolveProvider(registry, card.assetClass), now);
}
