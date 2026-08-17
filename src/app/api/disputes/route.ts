import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import {
  DISPUTE_CATEGORIES,
  DisputeError,
  OBSERVED_MAX_LEN,
  fileDispute,
  getOpenDisputes,
  resolveDispute,
} from '@/server/judgmentDisputeService';
import { requireOperatorId, requireUserId, toErrorResponse } from '../_lib/http';

// 판정 이의제기 — **구매자 → 플랫폼의 단방향 클레임.**
//
// 자유 서술을 받지 않는 것이 이 API의 핵심 제약이다. 사유는 **정해진 선택지**뿐이고,
// 함께 받는 것은 "확인한 실제 값"이라는 **대조할 수치** 하나다. 열어 두면
// "이 리서처 사기꾼이다"가 들어오고, 그 순간 이 창구는 거래 분쟁 처리가 아니라
// 리서처에 대한 의견 게시판이 된다 — 투자자문업 해석 위험이 시작되는 지점이다.

const fileSchema = z.object({
  purchaseId: z.string().min(1),
  category: z.enum(Object.keys(DISPUTE_CATEGORIES) as [string, ...string[]]),
  observed: z.string().max(OBSERVED_MAX_LEN).optional(),
});

const resolveSchema = z.object({
  disputeId: z.string().min(1),
  verdict: z.enum(['UPHELD', 'REJECTED']),
  resolution: z.string().min(1).max(500),
  /** 생체 재확인 표 (1인 운영 모드) — 생체를 통과한 화면이 방금 받은 1회용 값 */
  recheckToken: z.string().max(200).optional(),
});

/** 접수 (구매자 본인) */
export async function POST(req: NextRequest) {
  try {
    const buyerId = await requireUserId();
    const body = fileSchema.parse(await req.json());
    const dispute = await fileDispute(prisma, {
      purchaseId: body.purchaseId,
      buyerId,
      category: body.category as keyof typeof DISPUTE_CATEGORIES,
      observed: body.observed,
    });
    return NextResponse.json({ id: dispute.id }, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof DisputeError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}

/** 확정 (운영자) — 인정해도 판정을 자동으로 되돌리지는 않는다 (서비스 주석 참고) */
export async function PATCH(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = resolveSchema.parse(await req.json());
    const r = await resolveDispute(prisma, { ...body, operatorUserId });
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof DisputeError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}

/** 열린 이의 목록 (운영자) */
export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json({ disputes: await getOpenDisputes(prisma) });
  } catch (e) {
    return toErrorResponse(e);
  }
}
