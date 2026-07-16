import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ASSET_CLASSES } from '@/domain/constants';
import { prisma } from '@/server/db';
import { searchInstruments } from '@/server/instrumentService';
import { toErrorResponse } from '../_lib/http';

const querySchema = z.object({
  assetClass: z.enum(ASSET_CLASSES),
  q: z.string().min(1).max(50),
  shortOnly: z.enum(['0', '1']).default('0'),
});

/**
 * 종목 마스터 검색 — 카드 작성 화면용.
 * 시세 공급자가 지원하는 활성 종목만 반환한다 (하락 예측이면 shortOnly=1).
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const params = querySchema.parse(Object.fromEntries(searchParams));
    const results = await searchInstruments(prisma, params.assetClass, params.q, {
      shortableOnly: params.shortOnly === '1',
    });
    return NextResponse.json(results);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
