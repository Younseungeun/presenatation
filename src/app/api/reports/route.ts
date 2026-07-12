import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ASSET_CLASSES, DIRECTIONS, PREPAYMENT_RATIOS, TARGET_TYPES } from '@/domain/constants';
import { prisma } from '@/server/db';
import { createDraftReport } from '@/server/reportService';
import { requireResearcherId, toErrorResponse } from '../_lib/http';

const bodySchema = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  content: z.string().min(1),
  priceKrw: z.number().int(),
  prepaymentRatio: z
    .number()
    .refine((v): v is (typeof PREPAYMENT_RATIOS)[number] =>
      (PREPAYMENT_RATIOS as readonly number[]).includes(v),
    ),
  card: z.object({
    assetClass: z.enum(ASSET_CLASSES),
    ticker: z.string().min(1).max(20),
    assetName: z.string().min(1).max(100),
    direction: z.enum(DIRECTIONS),
    targetType: z.enum(TARGET_TYPES),
    targetValue: z.number(),
    deadline: z.coerce.date(),
    confidence: z.number().int().min(1).max(5).optional(),
  }),
});

/** 리포트 초안 생성 (예측 카드 포함) */
export async function POST(req: NextRequest) {
  try {
    const researcherId = requireResearcherId(req);
    const body = bodySchema.parse(await req.json());
    const report = await createDraftReport(prisma, { researcherId, ...body });
    return NextResponse.json(report, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
