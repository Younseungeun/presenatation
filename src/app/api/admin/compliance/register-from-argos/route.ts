import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { RISK_CATEGORIES } from '@/domain/compliance';
import { PHRASE_MAX_LENGTH } from '@/domain/learnedPhrases';
import { ItemPackError, registerPhraseFromArgos } from '@/server/itemTeacherPackService';
import { LearnedPhraseError } from '@/server/learnedPhraseService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

// 졸업 강등 본선의 실행 통로 (Q1) — ARGOS 유형별 모음에서 학습 표현을 등록한다.
// 출처(그 유형의 최근 확정 ARGOS 건)는 서버가 물린다 — 화면은 유형과 표현만 보낸다.

const bodySchema = z.object({
  category: z.enum(RISK_CATEGORIES),
  phrase: z.string().trim().min(1).max(PHRASE_MAX_LENGTH * 3),
  note: z.string().max(500).nullish(),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const created = await registerPhraseFromArgos(prisma, { ...body, operatorUserId });
    return NextResponse.json({ ok: true, phraseId: created.id });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof ItemPackError || e instanceof LearnedPhraseError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
