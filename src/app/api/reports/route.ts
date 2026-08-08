import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ASSET_CLASSES, DIRECTIONS, PREPAYMENT_RATIOS, TARGET_TYPES } from '@/domain/constants';
import { REPORT_TEXT_LIMITS } from '@/domain/publishReport';
import { prisma } from '@/server/db';
import { createDraftReport } from '@/server/reportService';
import { requireResearcherId, toErrorResponse } from '../_lib/http';

const bodySchema = z.object({
  // 상한은 도메인 상수가 단일 기준 (REPORT_TEXT_LIMITS) — 검수 입력 토큰 상한과 연동된다
  title: z.string().min(1).max(REPORT_TEXT_LIMITS.title),
  summary: z.string().min(1).max(REPORT_TEXT_LIMITS.summary),
  content: z.string().min(1).max(REPORT_TEXT_LIMITS.content),
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
    confidence: z.number().int().min(1).max(10),
    selfStability: z.number().int().min(1).max(10),
  }),
});

/** 리포트 초안 생성 (예측 카드 포함) */
export async function POST(req: NextRequest) {
  try {
    const researcherId = await requireResearcherId(prisma);
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
