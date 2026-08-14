import type { Prisma, PrismaClient } from '@prisma/client';
import { seasonOf } from './scoreService';

// 판정 되돌리기 — **UI는 없다. 스크립트만 있다** (npm run judgment:revert).
//
// 왜 지금 만드는가: 판정은 **돈과 점수를 동시에** 움직인다. SQL로 손보면 넷 중 하나를
// 빠뜨리기 쉬운데(에스크로·정산·점수·증거), 특히 마지막이 위험하다 — 규율 래더의
// 증거(Judgment.info)는 **평생 누적**이라 한 번 잘못 쌓이면 그 리서처의 신뢰도 상한이
// 영구히 틀어지고, 본인은 이유를 알 수 없다. 사고가 난 뒤에 짜면 손이 떨리는 상태에서
// 짜게 된다.
//
// **다행히 점수와 증거는 따로 되돌릴 것이 없다.** 시즌 점수(scoreService)도 규율
// 래더(domain/evidence)도 Judgment 행을 **그때그때 합산**하지 파생 테이블에 쌓아 두지
// 않는다. 행을 지우면 둘 다 함께 사라진다. 되감을 것은 돈(Settlement·escrowStatus)뿐이다.
//
// 지우는 이유는 보관하기 싫어서가 아니라 `Judgment.predictionCardId`가 unique이기
// 때문이다 — 남겨 두면 다시 판정할 수 없다. 그래서 지우기 전에 **JudgmentRevert에
// 통째로 옮겨 적는다**(append-only). 지웠다는 사실까지 지우면 안 된다.

/** 되돌릴 수 없는 이유 — 전부 "돈이 이미 밖으로 나갔다"의 변주다 */
export class JudgmentRevertBlocked extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'PAYOUT_EXECUTED'
      | 'REFUND_EXECUTED'
      | 'REFUND_IN_FLIGHT',
    message: string,
  ) {
    super(message);
    this.name = 'JudgmentRevertBlocked';
  }
}

export interface RevertResult {
  judgmentId: string;
  predictionCardId: string;
  outcome: string;
  /** 되돌린 정산 건수 (= HELD로 되돌린 구매 건수) */
  settlements: number;
  score: number | null;
  info: number | null;
  /**
   * 사람이 이어서 해야 하는 일 — **시스템이 못 고치는 것을 조용히 넘기지 않는다.**
   */
  followUps: string[];
}

/**
 * 왜 되돌리나 — **사유가 그 다음에 무슨 일이 일어날지를 정한다.**
 *
 * 되돌리기만 하고 자동 배치에 다시 던지면, 원인이 시세 소스였을 때 **같은 소스로 같은
 * 오답을 매긴다.** 사람이 또 되돌리고, 배치가 또 매기는 반복이 된다. 그렇다고 되돌린
 * 카드를 전부 수동으로만 판정하게 하면 반대로 너무 세다 — 우리 판정 로직 버그였다면
 * 고친 코드로 자동 재판정하는 것이 맞고, 그게 더 정확하다.
 *
 * 그래서 되돌리는 사람에게 **무엇이 틀렸는지**를 묻고 그 답으로 갈래를 정한다.
 */
export type RevertCause =
  /** 시세 소스가 잘못된 값을 줬다 — 같은 소스로 다시 매기면 같은 답이 나온다 */
  | 'DATA_SOURCE'
  /** 우리 판정 로직이 틀렸다 — 고친 코드로 자동 재판정하는 것이 맞다 */
  | 'PLATFORM_LOGIC';

export interface RevertInput {
  judgmentId: string;
  operatorUserId: string;
  reason: string;
  cause: RevertCause;
}

/**
 * 판정 1건을 없던 일로 되돌린다. 카드는 다시 미판정 상태가 되어 배치가 재판정한다.
 *
 * **돈이 이미 밖으로 나갔으면 거부한다.** 리서처 계좌로 들어간 돈도, 구매자에게
 * 환불된 돈도 우리가 도로 가져올 수 없다. 그 상황에서 장부만 되돌리면 **DB는 깨끗한데
 * 현실과 다른** 최악의 상태가 된다 — 그때부터는 사람이 연락해 환수하거나 다음 정산에서
 * 상계하는 **회계의 영역**이지 스크립트의 영역이 아니다.
 */
export async function revertJudgment(
  prisma: PrismaClient,
  input: RevertInput,
  now = new Date(),
): Promise<RevertResult> {
  const judgment = await prisma.judgment.findUnique({
    where: { id: input.judgmentId },
    include: {
      predictionCard: {
        include: { report: { include: { purchases: true, researcher: true } } },
      },
    },
  });
  if (!judgment) {
    throw new JudgmentRevertBlocked('NOT_FOUND', `판정을 찾을 수 없습니다: ${input.judgmentId}`);
  }

  const card = judgment.predictionCard;
  const purchaseIds = card.report.purchases.map((p) => p.id);
  const settlements = await prisma.settlement.findMany({
    where: { purchaseId: { in: purchaseIds } },
    include: { refundAttempts: true },
  });

  // ── 방어선 ────────────────────────────────────────────────
  // 돈이 실제로 움직였으면 여기서 멈춘다. 순서는 "되돌리기 가장 어려운 것"부터다
  for (const s of settlements) {
    if (s.payoutExecutedAt) {
      throw new JudgmentRevertBlocked(
        'PAYOUT_EXECUTED',
        `리서처 지급이 이미 실행됐습니다 (정산 ${s.id}, ${s.payoutExecutedAt.toISOString()}).\n` +
          `남의 계좌에서 돈을 도로 가져올 수는 없습니다 — 리서처에게 연락해 환수하거나 ` +
          `다음 정산에서 상계하는 회계 처리로 넘어가야 합니다.`,
      );
    }
    if (s.refundExecutedAt) {
      throw new JudgmentRevertBlocked(
        'REFUND_EXECUTED',
        `구매자 환불이 이미 실행됐습니다 (정산 ${s.id}, ${s.refundExecutedAt.toISOString()}).\n` +
          `되돌리려면 구매자에게 다시 청구해야 하는데, 그건 스크립트가 할 일이 아닙니다.`,
      );
    }
    // 실행 표시는 없지만 **시도가 떠 있는** 경우 — PENDING은 "나갔는지 우리가 모른다"는
    // 뜻이라 실행된 것으로 취급해야 안전하다 (settlementOpsService의 스윕이 정리한 뒤에 오라)
    const inFlight = s.refundAttempts.filter((a) => a.status !== 'FAILED');
    if (inFlight.length > 0) {
      throw new JudgmentRevertBlocked(
        'REFUND_IN_FLIGHT',
        `끝나지 않은 환불 시도가 있습니다 (정산 ${s.id}, ${inFlight.length}건).\n` +
          `PG로 나갔는지 확인되기 전에는 되돌릴 수 없습니다 — 환불 시도를 먼저 확정하세요.`,
      );
    }
  }

  // ── 사람이 이어서 해야 하는 일 ────────────────────────────
  const followUps: string[] = [];
  // 등급은 분기 재산정에서만 바뀐다. 이 판정이 이미 재산정된 시즌의 것이면 점수가
  // 사라져도 **그때 기록된 TierHistory는 그대로**다 — 자동으로 고쳐지지 않는다
  if (seasonOf(judgment.judgedAt) !== seasonOf(now)) {
    followUps.push(
      `이 판정은 ${seasonOf(judgment.judgedAt)} 시즌 건입니다 — 그 시즌의 등급 산정에 이미 ` +
        `반영됐고 TierHistory는 자동으로 바뀌지 않습니다. 등급 영향을 확인하세요.`,
    );
  }
  // 기준가 소급 확정(resolvedBasePrice)은 되돌리지 않는다 — 판정이 틀렸다고 해서
  // "그날의 종가"가 틀린 것은 아니다. 오히려 그 값이 있어야 재판정이 정확하다
  if (card.basePrice !== null) {
    followUps.push(
      `카드 기준가(${card.basePrice})는 그대로 둡니다 — 판정 오류와 별개로 확정된 사실이고, ` +
        `재판정도 이 값을 씁니다.`,
    );
  }
  followUps.push(
    input.cause === 'DATA_SOURCE'
      ? '시세 소스가 원인이라 **자동 재판정을 막았습니다** — /admin/judgments 큐에서 ' +
        '검증 시세를 직접 넣어 판정하세요. 그냥 두면 이 카드는 영원히 판정되지 않습니다.'
      : '판정 로직이 원인이라 자동 배치가 다시 매깁니다 — **코드를 먼저 고친 뒤** ' +
        '되돌렸는지 확인하세요. 안 고쳤으면 같은 답이 나옵니다.',
  );

  // ── 되돌리기 (한 트랜잭션) ────────────────────────────────
  const writes: Prisma.PrismaPromise<unknown>[] = [
    // ① 묘비를 먼저 세운다 — 지우는 것보다 남기는 것이 앞선다
    prisma.judgmentRevert.create({
      data: {
        predictionCardId: card.id,
        judgmentId: judgment.id,
        outcome: judgment.outcome,
        score: judgment.score,
        info: judgment.info,
        judgedAt: judgment.judgedAt,
        judgmentJson: JSON.stringify({
          ...judgment,
          predictionCard: undefined, // 관계는 빼고 판정 행 자체만
        }),
        settlementsJson: JSON.stringify(settlements),
        reason: input.reason,
        operatorUserId: input.operatorUserId,
        revertedAt: now,
      },
    }),
    // ② 정산을 지운다 (실행 전이라 돈은 안 움직였다)
    prisma.settlement.deleteMany({ where: { purchaseId: { in: purchaseIds } } }),
    // ③ 에스크로를 다시 잠근다
    prisma.purchase.updateMany({
      where: { id: { in: purchaseIds } },
      data: { escrowStatus: 'HELD' },
    }),
    // ④ 판정을 지운다 — 점수와 규율 래더 증거가 여기 붙어 있어 함께 사라진다
    prisma.judgment.delete({ where: { id: judgment.id } }),
    // ⑤ 다음 판정을 준비한다. 백오프를 지우고, **누가 다시 매길지**를 사유가 정한다 —
    //    시세 소스가 원인이면 자동 배치는 같은 답을 낼 뿐이라 사람에게 넘긴다
    prisma.predictionCard.update({
      where: { id: card.id },
      data: {
        deferCount: 0,
        nextAttemptAt: null,
        manualJudgmentOnly: input.cause === 'DATA_SOURCE',
      },
    }),
  ];

  // ⑥ **조용히 되돌리지 않는다.** 구매자는 "판정됐다"는 알림을 이미 받았고 화면에서
  //    결과를 봤다. 그것이 취소된 사실을 본인이 알아야 한다
  const notice = `${card.assetName} 예측의 판정이 취소되었습니다. 사유: ${input.reason}`;
  for (const p of card.report.purchases) {
    writes.push(
      prisma.notification.create({
        data: {
          userId: p.buyerId,
          type: 'JUDGMENT_RESULT',
          title: '판정 취소 — 다시 판정됩니다',
          body: `${notice}\n결제액은 다시 에스크로에 보관되며, 재판정 후 정산·환불됩니다.`,
          link: `/report/${card.reportId}`,
          createdAt: now,
        },
      }),
    );
  }
  writes.push(
    prisma.notification.create({
      data: {
        userId: card.report.researcher.userId,
        type: 'JUDGMENT_RESULT',
        title: '판정 취소 — 다시 판정됩니다',
        body: `${notice}\n이 판정의 점수(${Math.round(judgment.score ?? 0)}점)는 회수되며, 재판정 결과로 대체됩니다.`,
        link: `/researcher/${card.report.researcherId}`,
        createdAt: now,
      },
    }),
  );

  await prisma.$transaction(writes);

  return {
    judgmentId: judgment.id,
    predictionCardId: card.id,
    outcome: judgment.outcome,
    settlements: settlements.length,
    score: judgment.score,
    info: judgment.info,
    followUps,
  };
}
