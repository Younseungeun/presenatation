import type { PredictionCard } from '@prisma/client';
import type { AssetClass, BaseMode, Direction, TargetType } from '@/domain/constants';
import type { JudgeableCard } from '@/domain/judgmentPipeline';
import type { CardDraft } from '@/domain/publishReport';

// Prisma PredictionCard(문자열 컬럼) → 도메인 타입 매핑 단일 지점.
// SQLite가 enum을 지원하지 않아 DB는 문자열로 저장하고 여기서 한 번만 좁힌다.

/** 게시 검증용 CardDraft */
export function toCardDraft(card: PredictionCard): CardDraft {
  return {
    assetClass: card.assetClass as AssetClass,
    ticker: card.ticker,
    assetName: card.assetName,
    direction: card.direction as Direction,
    targetType: card.targetType as TargetType,
    targetValue: card.targetValue,
    deadline: card.deadline,
    confidence: card.confidence,
    selfStability: card.selfStability,
  };
}

/** 판정 배치용 JudgeableCard (게시 시각은 report에서 주입) */
export function toJudgeableCard(card: PredictionCard, publishedAt: Date): JudgeableCard {
  return {
    assetClass: card.assetClass as AssetClass,
    baseMode: card.baseMode as BaseMode,
    ticker: card.ticker,
    direction: card.direction as Direction,
    targetType: card.targetType as TargetType,
    targetValue: card.targetValue,
    basePrice: card.basePrice,
    withdrawn: card.withdrawnAt !== null,
    publishedAt,
    deadline: card.deadline,
  };
}
