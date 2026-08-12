import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ASSET_CLASSES } from '@/domain/constants';
import { cardStabilityLevel } from '@/domain/stability';
import { prisma } from '@/server/db';
import { getInstrumentSigma } from '@/server/instrumentSigma';
import { createDefaultRegistry } from '@/infra/marketData/registry';
import { toErrorResponse } from '../../_lib/http';

const querySchema = z.object({
  assetClass: z.enum(ASSET_CLASSES),
  ticker: z.string().min(1).max(20),
});

/**
 * 종목 실현 변동성 — 카드 작성 화면이 종목을 고른 순간 부른다.
 * 이 값 하나가 두 곳을 정한다: 카드에 붙을 안정성 별점, 그리고 p₀(정직 신뢰도의 기준).
 * 하루 캐시라 같은 종목을 반복해 골라도 시세 호출이 늘지 않는다.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const params = querySchema.parse(Object.fromEntries(searchParams));
    const sigmaDaily = await getInstrumentSigma(
      prisma,
      createDefaultRegistry(),
      params.assetClass,
      params.ticker,
    );
    return NextResponse.json({ sigmaDaily, stability: cardStabilityLevel(sigmaDaily) });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
