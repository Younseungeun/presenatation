import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auditOp } from '@/server/auditLog';
import { prisma } from '@/server/db';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 계좌 명의 불일치의 두 갈래 (시안 v3 scr-sec).
//
// **어느 쪽도 계좌 상태를 바꾸지 않는다.** 이름이 맞는지는 은행 조회가 답하는 것이지
// 운영자가 눈으로 정할 일이 아니다 — 여기서 상태를 열어 주면 대조 장치 자체가 없어진다.
//   보류 유지 → 확인했다는 사실만 감사에 남긴다 (계좌는 그대로 막혀 있다)
//   확인 요청 → 리서처에게 **다시 등록해 달라**고 알린다
const bodySchema = z.object({
  researcherUserId: z.string().min(1),
  action: z.enum(['HOLD', 'ASK']),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const { researcherUserId, action } = bodySchema.parse(await req.json());

    const account = await prisma.payoutAccount.findUnique({
      where: { researcherUserId },
      select: { status: true, accountLast4: true },
    });
    if (!account) {
      return NextResponse.json({ error: '등록된 계좌가 없습니다' }, { status: 404 });
    }
    if (account.status !== 'HOLDER_MISMATCH') {
      return NextResponse.json({ error: '명의가 어긋난 계좌가 아닙니다' }, { status: 400 });
    }

    if (action === 'ASK') {
      await prisma.notification.create({
        data: {
          userId: researcherUserId,
          type: 'PAYOUT_ACCOUNT_CHANGED',
          title: '정산 계좌 예금주명이 일치하지 않습니다',
          body:
            `등록하신 계좌(···${account.accountLast4})의 예금주명이 본인 인증 이름과 다릅니다. ` +
            '확인 전까지 이 계좌로는 정산이 나가지 않습니다 — 설정 › 정산 계좌에서 다시 등록해 주세요.',
          link: '/settings/payout',
        },
      });
    }

    await auditOp(prisma, {
      actor: operatorUserId,
      actorType: 'OPERATOR',
      action: 'PAYOUT_ACCOUNT_MISMATCH_REVIEWED',
      targetType: 'PayoutAccount',
      targetId: researcherUserId,
      before: { status: account.status },
      // **상태는 그대로다** — 확인했다는 사실만 남는다
      after: { status: account.status },
      reason: action === 'ASK' ? '리서처에게 재등록 요청 발송' : '보류 유지 — 확인함',
    });

    return NextResponse.json({ ok: true, notified: action === 'ASK' });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류' }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
