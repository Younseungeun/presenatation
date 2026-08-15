import type { Prisma, PrismaClient, PredictionCard, Purchase, Report } from '@prisma/client';
import type { JudgmentResult } from '@/domain/judgment';
import { settle } from '@/domain/settlement';
import { auditOp } from './auditLog';

// 판정 결과 영속화 + 에스크로 3분기 정산 + 인앱 알림 쓰기 묶음.
// 자동 배치(judgmentBatch)와 운영자 수동 판정(manualJudgmentService)이 공유한다 —
// 어느 경로로 판정하든 점수·정산·감사 기록·알림의 형태는 동일해야 한다.

export type CardWithHeldPurchases = PredictionCard & {
  report: Report & { purchases: Purchase[]; researcher: { userId: string } };
};

const OUTCOME_LABEL: Record<string, string> = {
  HIT: '적중',
  MISS: '실패',
  UNDECIDABLE: '판정 불가',
};

export interface JudgmentRecordInput {
  result: JudgmentResult;
  realizedReturnPct: number | null;
  score: number;
  /** 가중 전 정보량 — 규율 래더의 입력. scoreJudgedCard가 점수와 함께 낸다 */
  info: number;
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
        info: input.info,
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
  const label = OUTCOME_LABEL[result.outcome] ?? result.outcome;
  let payoutTotal = 0;
  let refundTotal = 0;

  for (const p of card.report.purchases) {
    const s = settle({
      amountKrw: p.amountKrw,
      feeRateBp: card.report.feeRateBp!,
      prepaymentRatio: card.report.prepaymentRatio,
      outcome: result.outcome,
    });
    payoutTotal += s.researcherPayoutKrw;
    refundTotal += s.buyerRefundKrw;
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
      // 구매자 알림: 판정 결과와 환불 여부를 즉시 통지 (환불 인지가 서비스 신뢰의 핵심)
      prisma.notification.create({
        data: {
          userId: p.buyerId,
          type: 'JUDGMENT_RESULT',
          title: `구매 리포트 판정: ${card.assetName} ${label}`,
          body:
            result.outcome === 'HIT'
              ? '예측이 적중했습니다. 결제액은 리서처에게 정산됩니다.'
              : result.outcome === 'MISS'
                ? `예측이 빗나갔습니다. ${s.buyerRefundKrw.toLocaleString()}원이 현금 환불됩니다.`
                : `판정 불가 처리되었습니다. 전액(${s.buyerRefundKrw.toLocaleString()}원)이 환불됩니다.`,
          link: `/report/${card.reportId}`,
          createdAt: now,
        },
      }),
    );
  }

  // 리서처 알림: 판정 결과 + 점수 + 정산 요약
  const settleSummary =
    card.report.purchases.length === 0
      ? '판매된 구매 건이 없습니다.'
      : payoutTotal > 0
        ? `${payoutTotal.toLocaleString()}원이 정산됩니다 (구매 ${card.report.purchases.length}건).`
        : `구매 ${card.report.purchases.length}건, ${refundTotal.toLocaleString()}원이 구매자에게 환불됩니다.`;
  writes.push(
    prisma.notification.create({
      data: {
        userId: card.report.researcher.userId,
        type: 'JUDGMENT_RESULT',
        title: `예측 판정: ${card.assetName} ${label}`,
        body: `점수 ${input.score > 0 ? '+' : ''}${Math.round(input.score)}점. ${settleSummary}`,
        link: `/researcher/${card.report.researcherId}`,
        createdAt: now,
      },
    }),
  );

  // **에스크로가 갈라지는 순간을 한 줄로 남긴다** (server/auditLog.ts).
  //
  // 정산이 몇 건이 되든 로그는 **판정 하나에 한 줄**이다. "정산 s_1이 왜 생겼나"는
  // 도메인 외래키를 타고 올라와(Settlement → Purchase → Report → PredictionCard →
  // Judgment) targetId로 조회한다 — 하위 id를 JSON에 담아 검색하게 만들면 SQLite에는
  // JSON 인덱스가 없어 풀스캔이 된다.
  //
  // actor가 사람이 아닌 것이 이 사건의 성질이다. 대부분의 돈 이동은 자동 판정이
  // 만들고, 그때 필요한 것은 "누가 눌렀나"가 아니라 **어떤 입력으로 그 결론이
  // 나왔나**다 — 그건 Judgment.marketSnapshotJson에 이미 있으므로 여기서는
  // dataSource만 가리키고 스냅샷을 다시 담지 않는다
  writes.push(
    auditOp(prisma, {
      actor: `system:${input.dataSource}`,
      actorType: input.dataSource.startsWith('manual:') ? 'OPERATOR' : 'SYSTEM',
      action: 'JUDGMENT_CREATED',
      targetType: 'PredictionCard',
      targetId: card.id,
      after: {
        outcome: result.outcome,
        settledPrice: result.settledPrice ?? null,
        score: Math.round(input.score),
        payoutKrw: payoutTotal,
        refundKrw: refundTotal,
        purchases: card.report.purchases.length,
      },
      at: now,
    }),
  );

  return writes;
}
