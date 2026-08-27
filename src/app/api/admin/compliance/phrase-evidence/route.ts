import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/server/db';
import { getPhraseEvidence } from '@/server/learnedPhraseService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

// 학습 표현의 매칭 증거 묶음 (회신 20호 요청 2) — 승격·졸업 심사 화면이 펼칠 때 지연 로드한다.
// 전 표현을 미리 부르면 목록 렌더가 hit 수만큼 무거워진다 — 사람이 펼친 하나만 부른다.

export async function GET(req: NextRequest) {
  try {
    await requireOperatorId(prisma);
    const phraseId = req.nextUrl.searchParams.get('phraseId');
    if (!phraseId) {
      return NextResponse.json({ error: 'phraseId 가 필요합니다' }, { status: 400 });
    }
    return NextResponse.json(await getPhraseEvidence(prisma, phraseId));
  } catch (e) {
    return toErrorResponse(e);
  }
}
