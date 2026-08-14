import type { PrismaClient } from '@prisma/client';

// 판정 이의제기 — **구매자 → 플랫폼의 단방향 클레임.**
//
// 이 창구가 없으면 "판정이 틀렸다"고 생각한 구매자가 갈 곳은 **카드사**뿐이다.
// 차지백은 우리가 아무것도 못 하는 자리에서 돈이 빠지는 것이고, 그 전에 우리 안에서
// 끝낼 기회를 스스로 없애는 셈이다. 분쟁 처리 절차가 없다는 사실 자체도 소비자
// 분쟁에서 불리하게 작동한다.
//
// **투자자문업 경계**: 이건 리서처에게 따지는 것이 아니라 **심판인 플랫폼에게 데이터
// 오류를 따지는 것**이다. 그래서 리서처는 이 표를 보지 못하고, 구매자에게는 자유
// 서술 대신 **정형화된 선택지**만 준다 — 자유 입력을 열면 "이 리서처 사기꾼이다"가
// 들어오고 창구의 성격이 바뀐다.

/** 고를 수 있는 것은 전부 **데이터에 관한 주장**이다 — 리서처에 관한 의견이 아니다 */
export const DISPUTE_CATEGORIES = {
  PRICE_DATA: '판정에 쓰인 시세가 실제와 다릅니다',
  CORPORATE_ACTION: '액면분할·배당락 등 권리 사건이 반영되지 않았습니다',
  TIMING: '판정 시각·검증 시한 적용이 잘못됐습니다',
  OTHER_SYSTEM: '그 밖의 시스템 오류',
} as const;

export type DisputeCategory = keyof typeof DISPUTE_CATEGORIES;

/**
 * 판정 후 이의를 제기할 수 있는 기간.
 *
 * 무한정 열어 두면 **정산이 영원히 확정되지 않는다** — 리서처 몫이 언제 나갈지
 * 아무도 모르는 상태가 된다. 반대로 너무 짧으면 판정 알림을 늦게 본 사람이 길을 잃는다.
 * 14일은 카드사 이의제기 관행과 얼추 맞고, 판정 알림(인앱)을 놓쳐도 한 번은 앱을
 * 열 만한 기간이다.
 */
export const DISPUTE_WINDOW_DAYS = 14;

/** 확인한 값은 **대조할 수치**지 의견이 아니다 — 길이를 막아 서술로 번지지 않게 한다 */
export const OBSERVED_MAX_LEN = 100;

export class DisputeError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'NOT_JUDGED' | 'WINDOW_CLOSED' | 'ALREADY_FILED' | 'BAD_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'DisputeError';
  }
}

export interface FileDisputeInput {
  purchaseId: string;
  buyerId: string;
  category: DisputeCategory;
  observed?: string;
}

/**
 * 이의를 접수한다. **접수 자체가 정산을 멈춘다** —
 * 판정이 뒤집힐 수 있는 건에 돈을 먼저 내보내면 되돌릴 방법이 없기 때문이다
 * (judgmentRevertService가 지급 실행된 건을 거부하는 것과 같은 이유).
 */
export async function fileDispute(
  prisma: PrismaClient,
  input: FileDisputeInput,
  now = new Date(),
) {
  if (!(input.category in DISPUTE_CATEGORIES)) {
    throw new DisputeError('BAD_INPUT', '알 수 없는 사유입니다');
  }
  const observed = input.observed?.trim().slice(0, OBSERVED_MAX_LEN) || null;

  const purchase = await prisma.purchase.findUnique({
    where: { id: input.purchaseId },
    include: {
      judgmentDispute: true,
      report: {
        select: {
          id: true,
          researcher: { select: { userId: true } },
          predictionCard: { select: { assetName: true, judgment: true } },
        },
      },
    },
  });
  // **자기 구매만** 제기할 수 있다 — 없는 것과 남의 것을 같은 메시지로 답해
  // 구매 여부가 새지 않게 한다
  if (!purchase || purchase.buyerId !== input.buyerId) {
    throw new DisputeError('NOT_FOUND', '구매 내역을 찾을 수 없습니다');
  }
  const judgment = purchase.report.predictionCard?.judgment;
  if (!judgment) {
    throw new DisputeError('NOT_JUDGED', '아직 판정되지 않은 카드입니다');
  }
  if (purchase.judgmentDispute) {
    throw new DisputeError('ALREADY_FILED', '이미 접수된 이의가 있습니다');
  }
  const daysSince = (now.getTime() - judgment.judgedAt.getTime()) / 86_400_000;
  if (daysSince > DISPUTE_WINDOW_DAYS) {
    throw new DisputeError(
      'WINDOW_CLOSED',
      `이의제기는 판정 후 ${DISPUTE_WINDOW_DAYS}일 이내에만 가능합니다 (${Math.floor(daysSince)}일 경과)`,
    );
  }

  const dispute = await prisma.judgmentDispute.create({
    data: {
      judgmentId: judgment.id,
      purchaseId: purchase.id,
      buyerId: input.buyerId,
      category: input.category,
      observed,
      createdAt: now,
    },
  });

  // **리서처에게는 사실만 알린다** — 누가 제기했는지도, 무엇을 주장하는지도 넘기지
  // 않는다. 넘기는 순간 이 창구가 구매자↔리서처 소통 경로가 된다
  await prisma.notification.create({
    data: {
      userId: purchase.report.researcher.userId,
      type: 'OPS_ALERT',
      title: '판정 검토 요청 접수 — 해당 건 정산 보류',
      body:
        `"${purchase.report.predictionCard?.assetName ?? ''}" 카드의 판정에 대해 시스템 검토가 접수되어 ` +
        '해당 구매 1건의 정산이 잠시 보류됩니다.\n' +
        '검토는 플랫폼이 시세 데이터로 진행하며, 결과가 나오면 알려드립니다. 다른 구매 건에는 영향이 없습니다.',
      link: `/report/${purchase.report.id}`,
      createdAt: now,
    },
  });

  return dispute;
}

/**
 * 열려 있는 이의가 있는 정산 id 집합 — **지급을 막는 데 쓴다.**
 * 판정이 뒤집힐 수 있는 건에 돈을 먼저 내보내면 되돌릴 방법이 없다.
 */
export async function settlementIdsWithOpenDispute(prisma: PrismaClient): Promise<Set<string>> {
  const open = await prisma.judgmentDispute.findMany({
    where: { status: 'OPEN' },
    select: { purchase: { select: { settlement: { select: { id: true } } } } },
  });
  return new Set(
    open.map((d) => d.purchase.settlement?.id).filter((id): id is string => id !== undefined),
  );
}

/** 운영자 큐 — 오래된 순 (기다리는 동안 정산이 멈춰 있다) */
export function getOpenDisputes(prisma: PrismaClient) {
  return prisma.judgmentDispute.findMany({
    where: { status: 'OPEN' },
    include: {
      judgment: {
        select: {
          outcome: true,
          settledPrice: true,
          judgedAt: true,
          dataSource: true,
          marketSnapshotJson: true,
          predictionCard: { select: { assetName: true, ticker: true, assetClass: true, deadline: true } },
        },
      },
      purchase: { select: { id: true, amountKrw: true, reportId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * 이의를 확정한다.
 *
 * **인정(UPHELD)해도 여기서 판정을 되돌리지는 않는다.** 되돌리기는 돈이 이미 나갔는지
 * 따지는 별도 절차(`npm run judgment:revert`)이고, 그 판단을 이의 확정에 묶으면
 * "인정 버튼 하나로 에스크로가 움직이는" 위험한 단축키가 된다. 여기서는 **판단만**
 * 기록하고, 실제 되돌리기는 운영자가 따로 실행한다.
 */
export async function resolveDispute(
  prisma: PrismaClient,
  input: {
    disputeId: string;
    operatorUserId: string;
    verdict: 'UPHELD' | 'REJECTED';
    /** 기각이어도 남긴다 — 같은 유형이 반복되면 그게 진짜 결함의 신호다 */
    resolution: string;
  },
  now = new Date(),
) {
  const dispute = await prisma.judgmentDispute.findUnique({
    where: { id: input.disputeId },
    include: { purchase: { select: { buyerId: true, reportId: true } } },
  });
  if (!dispute || dispute.status !== 'OPEN') {
    throw new DisputeError('NOT_FOUND', '열려 있는 이의가 아닙니다');
  }

  await prisma.$transaction([
    prisma.judgmentDispute.update({
      where: { id: dispute.id },
      data: {
        status: input.verdict,
        resolvedAt: now,
        resolvedBy: input.operatorUserId,
        resolution: input.resolution.slice(0, 500),
      },
    }),
    // **기각도 반드시 알린다.** 접수만 되고 아무 답이 없으면 그 사람은 카드사로 간다 —
    // 이 창구를 만든 이유가 바로 그것을 막는 것이다
    prisma.notification.create({
      data: {
        userId: dispute.purchase.buyerId,
        type: 'OPS_ALERT',
        title:
          input.verdict === 'UPHELD'
            ? '판정 검토 결과 — 오류가 확인되었습니다'
            : '판정 검토 결과 — 판정이 유지됩니다',
        body:
          input.verdict === 'UPHELD'
            ? `${input.resolution}\n판정을 다시 진행하며, 정산·환불도 재판정 결과에 따라 조정됩니다.`
            : `${input.resolution}\n판정에 사용된 시세와 규칙을 다시 확인했으나 오류를 발견하지 못했습니다.`,
        link: `/report/${dispute.purchase.reportId}`,
        createdAt: now,
      },
    }),
  ]);

  return { verdict: input.verdict, needsRevert: input.verdict === 'UPHELD' };
}
