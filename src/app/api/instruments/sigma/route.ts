import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ASSET_CLASSES } from '@/domain/constants';
import { cardStabilityLevel } from '@/domain/stability';
import { prisma } from '@/server/db';
import { getInstrumentSigmaResult } from '@/server/instrumentSigma';
import { INSUFFICIENT_MARKET_DATA } from '@/server/reportService';
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
 *
 * **게시 불가 여부도 여기서 돌려준다** — 표본이 모자란 종목은 게시 관문에서 막히는데,
 * 그 사실을 게시 버튼을 누른 뒤에 알면 리포트를 다 쓴 뒤에 헛수고가 된다.
 * 종목을 고르는 순간이 그것을 말해 줄 수 있는 가장 이른 자리다.
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const params = querySchema.parse(Object.fromEntries(searchParams));
    const result = await getInstrumentSigmaResult(
      prisma,
      createDefaultRegistry(),
      params.assetClass,
      params.ticker,
    );
    const sigmaDaily = result.sigma;
    const publishBlocked = sigmaDaily === null && result.reason === 'INSUFFICIENT_SAMPLES';
    return NextResponse.json({
      sigmaDaily,
      stability: cardStabilityLevel(sigmaDaily),
      publishBlocked,
      // 장애로 못 잰 경우는 막지 않으므로 문구도 주지 않는다 — 잠시 뒤 다시 재면 채워진다
      blockedReason: publishBlocked ? INSUFFICIENT_MARKET_DATA : null,
    });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
