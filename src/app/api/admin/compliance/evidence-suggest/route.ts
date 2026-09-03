import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { EvidenceSuggestError, suggestEvidence } from '@/server/evidenceSuggestService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

// 근거 문장 추천 (12차 C-3) — 근거 짚기를 펼칠 때 한 번 부른다. 사전은 서버에서만 맞춘다.

const bodySchema = z.object({
  reportId: z.string().min(1),
  categories: z.array(z.string().max(60)).max(20).optional(),
});

export async function POST(req: NextRequest) {
  try {
    await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    return NextResponse.json(await suggestEvidence(prisma, body));
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof EvidenceSuggestError) return NextResponse.json({ error: e.message }, { status: 400 });
    return toErrorResponse(e);
  }
}
