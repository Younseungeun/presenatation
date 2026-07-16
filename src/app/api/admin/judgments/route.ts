import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { UNDECIDABLE_REASONS } from '@/domain/constants';
import { prisma } from '@/server/db';
import { getManualJudgmentQueue, manualJudgeCard } from '@/server/manualJudgmentService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 판정 보류 큐: 자동 판정이 7일 이상 이월된 카드의 조회·수동 판정

const bodySchema = z.object({
  cardId: z.string().min(1),
  reason: z.string().min(1).max(2000),
  decision: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('PRICE'),
      priceAtDeadline: z.number().positive().optional(),
      highSincePublish: z.number().positive().optional(),
      lowSincePublish: z.number().positive().optional(),
      basePrice: z.number().positive().optional(),
    }),
    z.object({
      type: z.literal('UNDECIDABLE'),
      undecidableReason: z.enum(UNDECIDABLE_REASONS),
    }),
  ]),
});

/** 보류 큐 조회 */
export async function GET() {
  try {
    await requireOperatorId(prisma);
    const queue = await getManualJudgmentQueue(prisma);
    return NextResponse.json(queue);
  } catch (e) {
    return toErrorResponse(e);
  }
}

/** 수동 판정 실행 — 점수·정산까지 자동 경로와 동일하게 처리 */
export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const result = await manualJudgeCard(prisma, { ...body, operatorUserId });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
