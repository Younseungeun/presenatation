import type { Prisma, PrismaClient } from '@prisma/client';
import {
  COMPENSATION_CAUSES,
  type CompensationCause,
  compensationAmountKrw,
  isCompensable,
} from '@/domain/compensation';
import { auditOp } from './auditLog';
import { assertWithinMonthlyBudget } from './compensationBudget';
import { notifyOperators } from './opsAlert';
import { assertWithinDailyLimit } from './payoutVelocity';

// 플랫폼 귀책 보상의 생성·확정·실행.
//
// ── 지시서는 판정과 **같은 트랜잭션**에서 태어난다 ───────────────
// `buildCompensationWrites`는 실행하지 않고 쓰기 연산을 돌려준다 — 호출자가
// `buildJudgmentWrites`의 배열에 이어 붙여 한 번에 커밋한다. 따로 만들면 "카드는
// 닫혔는데 보상 지시서는 없는" 창이 열리고, 그 창에서 프로세스가 죽으면 **아무도
// 그 사실을 모른다**(닫힌 카드는 이미 정상 판정처럼 보인다). 감사 로그를 트랜잭션에
// 얹는 것과 같은 이유이고, 같은 이유로 **대화형 트랜잭션은 쓰지 않는다.**

export class CompensationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompensationError';
  }
}

/** buildCompensationWrites가 쓰는 것만 — 조회 형태가 바뀌어도 여기가 흔들리지 않게 */
export interface CompensableCard {
  id: string;
  assetName: string;
  report: {
    feeRateBp: number | null;
    researcher: { userId: string };
    purchases: { id: string; amountKrw: number; escrowStatus: string }[];
  };
}

/**
 * 판정 못 하고 닫는 카드의 보상 지시서 쓰기를 만든다 (실행하지 않는다).
 *
 * 구매가 없으면 빈 배열 — **판매되지 않은 카드에는 보상할 것이 없다.** 리서처가 잃은
 * 것은 점수뿐인데 판정 불가는 애초에 점수 0(표본 제외)이라 잃은 것이 없다.
 */
export function buildCompensationWrites(
  prisma: PrismaClient,
  card: CompensableCard,
  cause: CompensationCause,
  now: Date,
): Prisma.PrismaPromise<unknown>[] {
  const feeRateBp = card.report.feeRateBp;
  // 수수료가 없는 리포트(무료 시황)는 애초에 카드가 없다. 그래도 방어적으로 — 여기서
  // 0으로 가정하면 **대금 전액이 보상액이 되어** 역유인이 그대로 부활한다
  if (feeRateBp == null) return [];

  return card.report.purchases.filter(isCompensable).map((p) =>
    prisma.compensationInstruction.create({
      data: {
        purchaseId: p.id,
        predictionCardId: card.id,
        researcherUserId: card.report.researcher.userId,
        amountKrw: compensationAmountKrw({ amountKrw: p.amountKrw, feeRateBp }),
        cause,
        status: 'PENDING_REVIEW',
        createdAt: now,
      },
    }),
  );
}

/**
 * 사람이 확정해야 하는 보상 — **카드 단위로 묶어** 오래된 순.
 *
 * 사건은 카드 하나인데 구매가 셋이면 판단도 하나여야 한다. 행 셋을 따로 물으면
 * 운영자가 같은 질문("이 카드는 왜 판정을 못 했나")에 세 번 답하게 되고, 세 번 중
 * 한 번이 다르게 나오는 날이 온다.
 */
export async function getPendingCompensationReviews(prisma: PrismaClient) {
  const rows = await prisma.compensationInstruction.findMany({
    where: { status: 'PENDING_REVIEW' },
    include: {
      purchase: {
        select: {
          amountKrw: true,
          escrowStatus: true,
          report: { select: { title: true, researcherId: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const byCard = new Map<
    string,
    {
      predictionCardId: string;
      cause: CompensationCause;
      causeLabel: string;
      researcherUserId: string;
      createdAt: Date;
      totalKrw: number;
      rows: typeof rows;
    }
  >();
  for (const r of rows) {
    const g = byCard.get(r.predictionCardId);
    if (g) {
      g.totalKrw += r.amountKrw;
      g.rows.push(r);
      continue;
    }
    const cause = r.cause as CompensationCause;
    byCard.set(r.predictionCardId, {
      predictionCardId: r.predictionCardId,
      cause,
      causeLabel: COMPENSATION_CAUSES[cause] ?? r.cause,
      researcherUserId: r.researcherUserId,
      createdAt: r.createdAt,
      totalKrw: r.amountKrw,
      rows: [r],
    });
  }
  return [...byCard.values()];
}

/**
 * 운영자가 카드 하나의 귀책을 확정한다 — 보상하거나(APPROVE) 대상에서 뺀다(EXCLUDE).
 *
 * **결과를 판단하는 자리가 아니다.** 물어야 하는 것은 "그 예측이 맞았을까"가 아니라
 * "판정을 못 한 것이 우리 탓인가"뿐이다. `DATA_UNKNOWN`이면 거래소 공지에서
 * 그날 그 종목이 멈춰 있었는지를 보고 정한다 — 멈춰 있었으면 EXCLUDE(종목 사정),
 * 아니면 APPROVE(우리 피드 장애).
 */
export async function reviewCompensation(
  prisma: PrismaClient,
  input: {
    predictionCardId: string;
    operatorUserId: string;
    decision: 'APPROVE' | 'EXCLUDE';
    note?: string;
  },
  now = new Date(),
): Promise<number> {
  const note = input.note?.trim() || null;
  if (input.decision === 'EXCLUDE' && !note) {
    // 보상하지 않기로 한 판단은 **근거가 남아야 한다.** 승인은 규칙의 기본값이지만
    // 제외는 예외라, 나중에 "왜 이 리서처만 못 받았나"에 답할 문장이 필요하다
    throw new CompensationError('보상 대상에서 빼려면 사유를 적어주세요 (예: 거래소 공지 확인 — 당일 거래정지)');
  }

  const status = input.decision === 'APPROVE' ? 'APPROVED' : 'EXCLUDED';
  // 조건을 쓰기에 실어 보낸다 — 두 운영자가 동시에 눌러도 먼저 쓴 쪽만 이긴다
  const { count } = await prisma.compensationInstruction.updateMany({
    where: { predictionCardId: input.predictionCardId, status: 'PENDING_REVIEW' },
    data: { status, reviewedAt: now, reviewedBy: input.operatorUserId, reviewNote: note },
  });
  if (count === 0) {
    throw new CompensationError('확정 대기 중인 보상 건이 없습니다 — 이미 처리됐거나 대상이 아닙니다');
  }

  await prisma.$transaction([
    auditOp(prisma, {
      actor: input.operatorUserId,
      actorType: 'OPERATOR',
      action: 'COMPENSATION_REVIEWED',
      targetType: 'PredictionCard',
      targetId: input.predictionCardId,
      before: { status: 'PENDING_REVIEW' },
      after: { status, instructions: count },
      reason: note ?? undefined,
      at: now,
    }),
  ]);
  return count;
}

/**
 * 승인된 보상을 실행 기록한다 — **이체는 사람이 은행에서 하고 여기에는 기록만 남는다.**
 *
 * 계좌이체 환불과 같은 성질이다: 멱등키가 없으므로 "재시도"가 곧 이중 송금이다.
 * 참조번호를 요구하는 것 자체가 운영자를 은행 앱으로 되돌려 보내고, 거기서 이미 보낸
 * 이체가 보인다. 시스템 밖에서 일어난 현금 이동을 안으로 증명하는 유일한 수단이다.
 *
 * 지나는 벽은 **둘**이다 — 일일 출금 한도(피해 반경)와 월 보상 예산(손실 규모).
 * 쿨다운·이의 차단·PG 입금 지연은 지나지 않는다: 뒤집힐 판정이 없고, 이의는 판정에
 * 거는 것이며, 이 돈은 PG를 거치지 않는다.
 */
export async function executeCompensation(
  prisma: PrismaClient,
  input: { compensationId: string; operatorUserId: string; bankReference: string },
  now = new Date(),
): Promise<void> {
  const c = await prisma.compensationInstruction.findUnique({
    where: { id: input.compensationId },
    include: { purchase: { select: { report: { select: { id: true, title: true } } } } },
  });
  if (!c) throw new CompensationError('보상 건을 찾을 수 없습니다');
  if (c.status === 'EXECUTED') throw new CompensationError('이미 실행된 보상입니다');
  if (c.status !== 'APPROVED') {
    throw new CompensationError(
      `아직 실행할 수 없습니다 (${c.status}) — 카드의 귀책을 먼저 확정해주세요.`,
    );
  }
  const bankReference = input.bankReference.trim();
  if (!bankReference) {
    throw new CompensationError(
      '은행 이체 참조번호가 필요합니다 — 이체를 먼저 실행하고 그 번호를 입력해주세요 (계좌이체에는 멱등키가 없어 이 번호가 유일한 증명입니다)',
    );
  }

  await assertWithinDailyLimit(prisma, c.amountKrw, now);
  await assertWithinMonthlyBudget(prisma, c.amountKrw, now);

  // 검사와 쓰기 사이의 틈을 없앤다 — 조건을 쓰기에 실어 보낸다 (지급 경로와 같은 형태)
  const { count } = await prisma.compensationInstruction.updateMany({
    where: { id: c.id, status: 'APPROVED', executedAt: null },
    data: {
      status: 'EXECUTED',
      executedAt: now,
      executedBy: input.operatorUserId,
      bankReference,
    },
  });
  if (count === 0) {
    throw new CompensationError(
      '실행 직전에 상태가 바뀌었습니다 (다른 실행 또는 확정 취소) — 목록을 새로고침해주세요.',
    );
  }

  await prisma.$transaction([
    auditOp(prisma, {
      actor: input.operatorUserId,
      actorType: 'OPERATOR',
      action: 'COMPENSATION_EXECUTED',
      targetType: 'CompensationInstruction',
      targetId: c.id,
      before: { status: 'APPROVED' },
      after: { status: 'EXECUTED', amountKrw: c.amountKrw, bankReference },
      at: now,
    }),
    prisma.notification.create({
      data: {
        userId: c.researcherUserId,
        type: 'COMPENSATION_EXECUTED',
        title: `판정 불가 보상 지급: ${c.amountKrw.toLocaleString()}원`,
        body:
          `"${c.purchase.report.title}"은 저희 사정으로 판정하지 못해 구매자에게 전액 환불됐습니다. ` +
          '판매는 실제로 일어났으므로 판매 대금에서 수수료를 뺀 금액을 보상해 드렸습니다 ' +
          '(이 건의 수수료는 받지 않습니다). 점수에는 반영되지 않습니다 — 판정이 없었기 때문입니다.',
        link: `/report/${c.purchase.report.id}`,
        createdAt: now,
      },
    }),
  ]);
}

/**
 * 확정을 기다리는 보상이 쌓이면 운영자에게 알린다 (스케줄러가 하루 한 번 부른다).
 *
 * **큐 길이가 곧 사고 규모의 계기판이다.** 자동 승인 경로를 두지 않은 대가로 이 큐는
 * 방치되면 리서처 돈이 갇히는 자리가 되므로, 검수 보류 큐와 같은 규칙을 쓴다 —
 * 사람을 기다리는 큐는 스스로 소리를 내야 한다.
 */
export const COMPENSATION_REVIEW_OVERDUE_DAYS = 3;

export async function sweepPendingCompensations(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ pending: number; overdue: number; notified: boolean }> {
  const rows = await prisma.compensationInstruction.findMany({
    where: { status: 'PENDING_REVIEW' },
    select: { predictionCardId: true, amountKrw: true, cause: true, createdAt: true },
  });
  if (rows.length === 0) return { pending: 0, overdue: 0, notified: false };

  const cutoff = new Date(now.getTime() - COMPENSATION_REVIEW_OVERDUE_DAYS * 86_400_000);
  const overdueCards = new Set(
    rows.filter((r) => r.createdAt < cutoff).map((r) => r.predictionCardId),
  );
  const cards = new Set(rows.map((r) => r.predictionCardId));
  if (overdueCards.size === 0) {
    return { pending: cards.size, overdue: 0, notified: false };
  }

  const total = rows.reduce((a, r) => a + r.amountKrw, 0);
  await notifyOperators(prisma, {
    title: `[확인 필요] 귀책 확정을 기다리는 보상 ${cards.size}건 · ${total.toLocaleString()}원`,
    body: [
      `${COMPENSATION_REVIEW_OVERDUE_DAYS}일 넘게 확정되지 않은 카드가 ${overdueCards.size}건 있습니다.`,
      '구매자는 이미 전액 환불받았고, 리서처는 확정될 때까지 아무것도 못 받습니다.',
      '물어야 하는 것은 "그 예측이 맞았을까"가 아니라 **"판정을 못 한 것이 우리 탓인가"**입니다.',
    ].join('\n'),
    link: '/admin/settlements',
    dedupeKey: `compensation-review:${now.toISOString().slice(0, 10)}`,
    dedupeMs: 24 * 3_600_000,
  });
  return { pending: cards.size, overdue: overdueCards.size, notified: true };
}
