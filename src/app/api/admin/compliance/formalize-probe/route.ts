import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { FormalizationProbeError, probeFailed } from '@/domain/formalizationProbe';
import { FormalizationProbeServiceError, probeFormalization } from '@/server/formalizationProbeService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

// 공식화 샌드박스 (12차 검토 C-4) — 졸업 폼에서 후보 표현/패턴을 돌려 본다.
// 결과는 표현에 저장되고 졸업 관문이 "마지막 시도가 실패했나"를 본다.

const bodySchema = z.object({
  phraseId: z.string().min(1),
  pattern: z.string().min(1).max(200),
  // 정규식은 창업자용 — 운영자는 문자열(정규화 부분 일치)
  isRegex: z.boolean().default(false),
});

export async function POST(req: NextRequest) {
  try {
    await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const result = await probeFormalization(prisma, body);
    return NextResponse.json({ ...result, failed: probeFailed(result) });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    if (e instanceof FormalizationProbeError || e instanceof FormalizationProbeServiceError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
