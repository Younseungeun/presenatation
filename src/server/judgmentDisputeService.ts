import type { PrismaClient } from '@prisma/client';
import { auditOp } from './auditLog';
import {
  ApprovalError,
  consumeApproval,
  consumeOperatorRecheck,
  isSoloOperatorMode,
  requestApproval,
} from './operatorApprovalService';

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
    readonly code:
      | 'NOT_FOUND'
      | 'NOT_JUDGED'
      | 'WINDOW_CLOSED'
      | 'ALREADY_FILED'
      | 'BAD_INPUT'
      | 'APPROVAL_PENDING'
      | 'RECHECK_REQUIRED',
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
      actorRole: 'PURCHASER',
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
    // **구매자 이의만 정산을 멈춘다** (2026-08-15).
    //
    // 리서처 이의로 환불을 멈추면, 틀린 판정이 아니어도 **구매자 돈이 리서처의 항의만으로
    // 묶인다.** 구매자를 리서처와 플랫폼 사이 분쟁의 인질로 두지 않는다 — 환불은 나가고,
    // 이의가 인정되면 리서처 몫은 **플랫폼이 부담해서** 지급한다.
    //
    // 비대칭이 정당한 이유: 구매자 이의는 "이미 나갈 뻔한 남의 돈"을 멈추는 것이고
    // 리서처 이의는 "이미 내 것이 아니게 된 돈"을 되찾는 것이다. 앞은 예방이고 뒤는 보전이라
    // 예방만이 흐름을 멈출 자격이 있다.
    where: { status: 'OPEN', actorRole: 'PURCHASER' },
    select: { purchase: { select: { settlement: { select: { id: true } } } } },
  });
  return new Set(
    open.map((d) => d.purchase?.settlement?.id).filter((id): id is string => id !== undefined),
  );
}

/** 운영자 큐 — 오래된 순 (기다리는 동안 정산이 멈춰 있다) */
export function getOpenDisputes(prisma: PrismaClient) {
  return prisma.judgmentDispute.findMany({
    where: { status: 'OPEN' },
    include: {
      judgment: {
        select: {
          id: true,
          outcome: true,
          settledPrice: true,
          realizedReturnPct: true,
          judgedAt: true,
          dataSource: true,
          marketSnapshotJson: true,
          predictionCard: {
            select: {
              assetName: true,
              ticker: true,
              assetClass: true,
              deadline: true,
              direction: true,
              targetType: true,
              targetValue: true,
              basePrice: true,
              // 리서처 이의는 구매에 안 붙으므로 리포트로 가는 길이 카드뿐이다
              reportId: true,
            },
          },
        },
      },
      purchase: { select: { id: true, amountKrw: true, reportId: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
}

export type OpenDispute = Awaited<ReturnType<typeof getOpenDisputes>>[number];

/**
 * **인정했는데 아직 되돌리지 않은 이의** — 화면이 없으면 여기서 조용히 끊긴다.
 *
 * `resolveDispute`는 일부러 판정을 자동으로 되돌리지 않는다("인정 버튼 하나로 에스크로가
 * 움직이는" 단축키를 만들지 않으려고). 대신 사람이 이어서 실행해야 하는데, 그 사람에게
 * 목록이 없으면 **인정만 되고 아무 일도 안 일어난 건**이 쌓인다. 구매자에게는
 * "오류가 확인되었습니다"라고 알린 뒤라 가장 나쁜 침묵이다.
 *
 * 되돌리면 판정 행이 사라지면서 `judgmentId`가 null이 되므로(SetNull), 이 목록은
 * **스스로 비워진다** — 따로 완료 표시를 만들 필요가 없다.
 */
export function getUpheldPendingRevert(prisma: PrismaClient) {
  return prisma.judgmentDispute.findMany({
    where: { status: 'UPHELD', judgmentId: { not: null } },
    include: {
      judgment: {
        select: {
          id: true,
          outcome: true,
          judgedAt: true,
          predictionCard: { select: { assetName: true, ticker: true } },
        },
      },
      purchase: { select: { reportId: true } },
    },
    orderBy: { resolvedAt: 'asc' },
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
    /** 생체 재확인 표 (1인 운영 모드) — 생체를 통과한 화면만 가질 수 있는 1회용 값 */
    recheckToken?: string;
  },
  now = new Date(),
) {
  const dispute = await prisma.judgmentDispute.findUnique({
    where: { id: input.disputeId },
    include: {
      purchase: { select: { buyerId: true, reportId: true } },
      judgment: {
        select: { predictionCard: { select: { reportId: true, assetName: true, ticker: true } } },
      },
    },
  });
  if (!dispute || dispute.status !== 'OPEN') {
    throw new DisputeError('NOT_FOUND', '열려 있는 이의가 아닙니다');
  }

  // **결과는 제기한 사람에게 간다** — 청구인이 둘이라 받는 사람도 둘이다.
  // 리서처 이의는 구매에 안 붙으므로 판정 → 카드 → 리포트로 타고 올라간다
  let claimantUserId: string;
  let reportId: string;
  if (dispute.actorRole === 'RESEARCHER') {
    const profile = await prisma.researcherProfile.findUnique({
      where: { id: dispute.researcherId ?? '' },
      select: { userId: true },
    });
    if (!profile) throw new DisputeError('NOT_FOUND', '제기한 리서처를 찾을 수 없습니다');
    claimantUserId = profile.userId;
    reportId = dispute.judgment?.predictionCard?.reportId ?? '';
  } else {
    if (!dispute.purchase) throw new DisputeError('NOT_FOUND', '구매 내역을 찾을 수 없습니다');
    claimantUserId = dispute.purchase.buyerId;
    reportId = dispute.purchase.reportId;
  }

  // ── 인정은 2인 승인이다 (2026-08-16 검토 3차) ────────────────
  // 인정은 **사람이 데이터의 판정을 뒤집는 결정**이고, 그 끝에 환불이라는 형태로
  // 돈이 움직인다 — 내부자와 공모한 구매자가 노리는 자리가 정확히 여기다.
  // 기각은 걸지 않는다: 데이터의 판정을 유지하는 쪽이라 사람의 손이 새로 안 들어간다.
  // 이미 되돌려진 판정(judgmentId가 끊긴 건)의 인정도 걸지 않는다: 뒤집기는 이미
  // 일어났고 남은 것은 사후 기록과 통지뿐이다 — 결정에 거는 관문을 기록에 걸면
  // 같은 결정을 두 번 세는 것이다.
  //
  // 승인이 없으면 **여기서 승인 요청을 대신 올리고** 멈춘다 — 운영자가 쓴 판단
  // 근거(resolution)가 그대로 승인자가 읽을 사유가 된다. 승인 뒤 같은 확정을 한 번 더
  // 실행하면 그때 승인서가 소비된다. (자리는 확정 직전 — 청구인 확인에서 막힐 건에
  // 승인서를 태우지 않는다)
  if (input.verdict === 'UPHELD' && dispute.judgmentId) {
    try {
      await consumeApproval(prisma, { action: 'DISPUTE_UPHOLD', targetId: dispute.id }, now);
    } catch (e) {
      if (!(e instanceof ApprovalError)) throw e;
      // 승인서가 없다 — 1인 운영이면 생체 재확인, 다인이면 요청을 올리고 대기
      // (2026-08-17 사용자 확정 — unfreezePayouts와 같은 갈림)
      if (await isSoloOperatorMode(prisma)) {
        try {
          await consumeOperatorRecheck(prisma, input.operatorUserId, input.recheckToken, now);
        } catch (re) {
          if (!(re instanceof ApprovalError)) throw re;
          throw new DisputeError('RECHECK_REQUIRED', re.message);
        }
      } else {
        const card = dispute.judgment?.predictionCard;
        await requestApproval(
          prisma,
          {
            action: 'DISPUTE_UPHOLD',
            targetId: dispute.id,
            summary: `${card ? `${card.assetName} (${card.ticker})` : '판정'} 이의 인정 — 판정을 뒤집는 결정`,
            requestedBy: input.operatorUserId,
            reason: input.resolution,
          },
          now,
        );
        throw new DisputeError(
          'APPROVAL_PENDING',
          '판정을 뒤집는 결정에는 다른 운영자의 승인이 필요합니다 — 승인 요청을 올려두었습니다. ' +
            '승인되면 여기서 다시 확정하세요.',
        );
      }
    }
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
        userId: claimantUserId,
        type: 'OPS_ALERT',
        title:
          input.verdict === 'UPHELD'
            ? '판정 검토 결과 — 오류가 확인되었습니다'
            : '판정 검토 결과 — 판정이 유지됩니다',
        body:
          input.verdict === 'UPHELD'
            ? `${input.resolution}\n판정을 다시 진행하며, 정산·환불도 재판정 결과에 따라 조정됩니다.`
            : `${input.resolution}\n판정에 사용된 시세와 규칙을 다시 확인했으나 오류를 발견하지 못했습니다.`,
        link: `/report/${reportId}`,
        createdAt: now,
      },
    }),
    // 이의 확정은 **돈을 움직이지는 않지만 돈의 근거를 바꾼다** — 인정은 되돌리기로,
    // 기각은 정산 재개로 이어진다. 감사 로그가 봐야 하는 것이 정확히 그런 사건이다
    auditOp(prisma, {
      actor: input.operatorUserId,
      actorType: 'OPERATOR',
      action: 'DISPUTE_RESOLVED',
      targetType: 'JudgmentDispute',
      targetId: dispute.id,
      before: { status: 'OPEN' },
      after: { status: input.verdict, settlementUnlocked: input.verdict === 'REJECTED' },
      reason: input.resolution.slice(0, 500),
      at: now,
    }),
  ]);

  return { verdict: input.verdict, needsRevert: input.verdict === 'UPHELD' };
}

// ─────────────────────────────────────────────────────────────
// **리서처 이의** (2026-08-15, 외부 검토 반영)
//
// 실패 판정에서 억울한 쪽은 리서처인데 그쪽에는 창구가 없었다. 이 표를 구매자 전용으로
// 만든 근거는 투자자문업 경계였는데, 그것이 막으려던 것은 **리서처↔구매자 소통**이지
// 리서처가 심판에게 데이터 오류를 따지는 일이 아니다. 후자는 구매자 이의와 완전히
// 같은 성질이라 같은 표를 쓴다.
// ─────────────────────────────────────────────────────────────

/**
 * 리서처가 고를 수 있는 사유 — 구매자와 같은 축이되 **"판정이 나에게 불리하다"가 없다.**
 * 여기 있는 것은 전부 스냅샷과 대조 가능한 주장이다.
 */
export const RESEARCHER_DISPUTE_CATEGORIES = {
  PRICE_DATA: '판정에 쓰인 시세가 실제와 다릅니다',
  CORPORATE_ACTION: '액면분할·배당락 등 권리 사건이 반영되지 않았습니다',
  TIMING: '판정 시각·검증 시한 적용이 잘못됐습니다',
} as const;

/**
 * **남용은 점수로 막지 않는다** (외부 검토의 "신뢰도 포인트 차감"을 받지 않은 이유).
 *
 * ① vmax 점수는 **적정 점수법**이라 "예측과 결과만의 함수"라는 성질에서 모든 보장이
 *    나온다(정직 신고가 유일한 최적, 무실력자 기대값 ≤ 0). 예측이 아닌 행위로 점수를
 *    깎으면 그 성질이 깨진다 — 점수가 더 이상 "시장에 더한 정보량"이 아니게 된다.
 * ② 더 나쁜 것은 규율 래더다. Ville 부등식의 보장
 *    `P(언젠가 D ≤ −ln(1/α)) ≤ α`는 D가 정직 신고 아래 마팅게일일 때만 성립한다.
 *    이의마다 상수를 빼면 **α가 더 이상 오작동률이 아니다** — 사다리의 수학적 척추가
 *    부러진다. 게다가 벌받는 쪽이 "플랫폼 데이터 오류의 피해자"가 된다.
 * ③ 물량 자체가 문제가 아니다 — 판정 하나에 이의 하나이므로 활성 카드 상한(5~15장)이
 *    이미 상한이다.
 *
 * 대신 **구조로 막는다**: 맞다고 보는 가격을 대야 접수된다. 그러면 "억울하다"는 낼 수
 * 없고 "8/1 종가는 71,200원이다"만 낼 수 있으며, 그 주장은 판정 스냅샷과 기계적으로
 * 대조되므로 운영자 시간이 거의 들지 않는다.
 */
export interface FileResearcherDisputeInput {
  cardId: string;
  researcherId: string;
  category: keyof typeof RESEARCHER_DISPUTE_CATEGORIES;
  /** 맞다고 주장하는 가격 — **필수**. 이것이 곧 남용 방지 장치다 */
  claimedPrice: number;
  /** 어디서 확인했는가 (예: "KRX 정보데이터시스템 8/1 종가") */
  observed?: string;
}

export async function fileResearcherDispute(
  prisma: PrismaClient,
  input: FileResearcherDisputeInput,
  now = new Date(),
) {
  if (!(input.category in RESEARCHER_DISPUTE_CATEGORIES)) {
    throw new DisputeError('BAD_INPUT', '알 수 없는 사유입니다');
  }
  if (!(input.claimedPrice > 0) || !Number.isFinite(input.claimedPrice)) {
    throw new DisputeError(
      'BAD_INPUT',
      '맞다고 보시는 가격을 적어주세요 — 판정 스냅샷과 대조할 수치가 있어야 검토할 수 있습니다',
    );
  }
  const observed = input.observed?.trim().slice(0, OBSERVED_MAX_LEN) || null;

  const card = await prisma.predictionCard.findUnique({
    where: { id: input.cardId },
    include: {
      judgment: { select: { id: true, judgedAt: true, outcome: true } },
      report: { select: { id: true, researcherId: true } },
    },
  });
  // **자기 카드만** — 없는 것과 남의 것을 같은 메시지로 답한다 (구매자 쪽과 같은 규칙)
  if (!card || card.report.researcherId !== input.researcherId) {
    throw new DisputeError('NOT_FOUND', '카드를 찾을 수 없습니다');
  }
  if (!card.judgment) {
    throw new DisputeError('NOT_JUDGED', '아직 판정되지 않은 카드입니다');
  }

  const daysSince = (now.getTime() - card.judgment.judgedAt.getTime()) / 86_400_000;
  if (daysSince > DISPUTE_WINDOW_DAYS) {
    throw new DisputeError(
      'WINDOW_CLOSED',
      `이의제기는 판정 후 ${DISPUTE_WINDOW_DAYS}일 이내에만 가능합니다 (${Math.floor(daysSince)}일 경과)`,
    );
  }

  // 판정 하나에 리서처 이의 하나 — 같은 주장을 다시 낸다고 답이 달라지지 않는다
  const existing = await prisma.judgmentDispute.findFirst({
    where: { judgmentId: card.judgment.id, actorRole: 'RESEARCHER' },
  });
  if (existing) {
    throw new DisputeError('ALREADY_FILED', '이미 접수된 이의가 있습니다');
  }

  return prisma.judgmentDispute.create({
    data: {
      judgmentId: card.judgment.id,
      actorRole: 'RESEARCHER',
      researcherId: input.researcherId,
      category: input.category,
      claimedPrice: input.claimedPrice,
      observed,
      createdAt: now,
    },
  });
}
