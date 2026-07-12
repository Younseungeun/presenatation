import { judge, type JudgmentResult, type PredictionInput } from './judgment';
import {
  buildMarketSnapshot,
  toKstDateString,
  type DailyQuote,
  type MarketDataProvider,
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

export interface JudgeableCard extends PredictionInput {
  ticker: string;
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
}

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

  const from = toKstDateString(card.publishedAt);
  const deadlineDate = toKstDateString(card.deadline);

  const [quotes, securityStatus] = await Promise.all([
    provider.getDailyQuotes(card.ticker, from, deadlineDate),
    provider.getSecurityStatus(card.ticker, deadlineDate),
  ]);

  // 정상 종목인데 시세가 전무하면 소스 지연(D+1) 가능성 — 판정하지 않고 이월
  if (!securityStatus.delisted && !securityStatus.halted && quotes.length === 0) {
    throw new JudgmentDeferredError(
      `${card.ticker}: ${from}~${deadlineDate} 시세 데이터 없음 (소스 지연 가능)`,
      'DATA_NOT_AVAILABLE',
    );
  }

  const snapshot = buildMarketSnapshot(quotes, securityStatus, deadlineDate);
  return {
    result: judge(card, snapshot),
    audit: {
      dataSource: provider.sourceId,
      fetchedAt: now.toISOString(),
      quotes,
      securityStatus,
    },
  };
}
