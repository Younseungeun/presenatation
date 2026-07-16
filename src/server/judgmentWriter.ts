import type { Prisma, PrismaClient, PredictionCard, Purchase, Report } from '@prisma/client';
import type { JudgmentResult } from '@/domain/judgment';
import { settle } from '@/domain/settlement';

// 판정 결과 영속화 + 에스크로 3분기 정산 쓰기 묶음.
// 자동 배치(judgmentBatch)와 운영자 수동 판정(manualJudgmentService)이 공유한다 —
// 어느 경로로 판정하든 점수·정산·감사 기록의 형태는 동일해야 한다.

export type CardWithHeldPurchases = PredictionCard & {
  report: Report & { purchases: Purchase[] };
};

export interface JudgmentRecordInput {
  result: JudgmentResult;
  realizedReturnPct: number | null;
  score: number;
  dataSource: string;
  /** 감사·분쟁 재현용 스냅샷 (JSON 직렬화 가능한 객체) */
  audit: unknown;
  /** 소급 확정된 기준가 — 있으면 카드에도 기록 */
  resolvedBasePrice?: number | null;
}

/**
 * 판정 1건의 전체 쓰기(판정 레코드 + 기준가 소급 + 정산/에스크로 갱신)를 반환한다.
 * 호출자가 $transaction으로 묶어 원자적으로 실행한다.
 * 멱등성은 Judgment.predictionCardId unique가 보장 — 중복 실행 시 트랜잭션 전체가 실패한다.
 */
export function buildJudgmentWrites(
  prisma: PrismaClient,
  card: CardWithHeldPurchases,
  input: JudgmentRecordInput,
  now: Date,
): Prisma.PrismaPromise<unknown>[] {
  const { result } = input;
  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.judgment.create({
      data: {
        predictionCardId: card.id,
        outcome: result.outcome,
        undecidableReason: result.undecidableReason ?? null,
        settledPrice: result.settledPrice ?? null,
        realizedReturnPct: input.realizedReturnPct,
        score: input.score,
        dataSource: input.dataSource,
        marketSnapshotJson: JSON.stringify(input.audit),
        judgedAt: now,
      },
    }),
  ];

  // 소급 확정된 기준가를 카드에 기록 (감사 추적)
  if (input.resolvedBasePrice != null) {
    writes.push(
      prisma.predictionCard.update({
        where: { id: card.id },
        data: { basePrice: input.resolvedBasePrice },
      }),
    );
  }

  // 에스크로 3분기 정산 — 금액 보존 불변식은 settle()이 보장.
  // 환불은 항상 현금(확정) — Settlement 기록이 PG 취소/계좌이체 지시서 역할.
  // 전액 환불 건만 REFUNDED로 구분.
  for (const p of card.report.purchases) {
    const s = settle({
      amountKrw: p.amountKrw,
      feeRateBp: card.report.feeRateBp!,
      prepaymentRatio: card.report.prepaymentRatio,
      outcome: result.outcome,
    });
    writes.push(
      prisma.settlement.create({
        data: {
          purchaseId: p.id,
          outcome: s.outcome,
          researcherPayoutKrw: s.researcherPayoutKrw,
          platformFeeKrw: s.platformFeeKrw,
          buyerRefundKrw: s.buyerRefundKrw,
          refundType: s.refundType,
          settledAt: now,
        },
      }),
      prisma.purchase.update({
        where: { id: p.id },
        data: { escrowStatus: s.buyerRefundKrw === p.amountKrw ? 'REFUNDED' : 'SETTLED' },
      }),
    );
  }

  return writes;
}
