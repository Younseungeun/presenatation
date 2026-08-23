import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { auditOp } from '@/server/auditLog';
import { prisma } from '@/server/db';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

/**
 * 보상 **안내 완료** 기록 (시안 rp-4).
 *
 * 쿠폰 시스템이 없어 지급은 손으로 한다. 그런데 손으로 한 일을 적을 자리가 없어서
 * "안내 대기" 목록은 **한 번 들어오면 나가지 못했다** — 큐가 영영 줄지 않는다.
 *
 * 안내 완료는 **지급 완료가 아니다.** `rewarded`는 그대로 둔다: 쿠폰이 생기면 이
 * 목록으로 소급 발행할 것이고, 그때 필요한 것은 "보상 대상이었다"는 사실이다.
 * 지금 끄는 것은 "내가 말을 걸었는가" 하나뿐이다.
 */
const bodySchema = z.object({
  reportId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const { reportId } = bodySchema.parse(await req.json());

    // 리포트 단위로 닫는다 — 안내는 한 번에 여러 신고자에게 나가고, 한 사람만 닫으면
    // 같은 묶음이 목록에 반쯤 남아 다시 안내하게 된다
    const targets = await prisma.abuseReport.findMany({
      where: { reportId, status: 'CONFIRMED', rewarded: true, rewardNoticedAt: null },
      select: { id: true },
    });
    if (targets.length === 0) {
      return NextResponse.json({ error: '안내를 기다리는 건이 없습니다' }, { status: 404 });
    }

    const now = new Date();
    await prisma.abuseReport.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { rewardNoticedAt: now },
    });

    await auditOp(prisma, {
      actor: operatorUserId,
      actorType: 'OPERATOR',
      action: 'ABUSE_REWARD_NOTICED',
      targetType: 'Report',
      targetId: reportId,
      before: { noticed: 0 },
      after: { noticed: targets.length },
      reason: '보상 안내 완료 — 쿠폰 발행 시 이 목록으로 소급',
    });

    return NextResponse.json({ ok: true, noticed: targets.length });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류' }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
