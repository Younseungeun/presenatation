import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { executeCompensation, reviewCompensation } from '@/server/compensationService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 플랫폼 귀책 보상 — 확정(REVIEW)과 실행(EXECUTE) (2026-08-18 전수 점검에서 배선).
//
// 이 라우트가 생기기 전까지 reviewCompensation·executeCompensation은 **아무도 부르지
// 않는 함수**였다. 지시서는 판정이 만들고, 3일 지연 알림은 매일 울리는데, 알림이
// 가리키는 화면에 처리 수단이 없었다 — 문 없는 방을 노크하는 구조였다.
//
// 두 동작을 한 라우트에 두는 이유: 같은 표의 같은 건을 다루는 연속 동작이고,
// 정산 라우트(/api/admin/settlements)가 환불·지급·확정을 한 곳에 두는 것과 같은 꼴이다.

const bodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('REVIEW'),
    predictionCardId: z.string().min(1),
    decision: z.enum(['APPROVE', 'EXCLUDE']),
    note: z.string().max(300).optional(),
  }),
  z.object({
    kind: z.literal('EXECUTE'),
    compensationId: z.string().min(1),
    bankReference: z.string().min(1).max(80),
    recheckToken: z.string().optional(),
  }),
]);

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());

    if (body.kind === 'REVIEW') {
      const count = await reviewCompensation(prisma, {
        predictionCardId: body.predictionCardId,
        operatorUserId,
        decision: body.decision,
        note: body.note,
      });
      return NextResponse.json({ ok: true, instructions: count });
    }

    await executeCompensation(prisma, {
      compensationId: body.compensationId,
      operatorUserId,
      bankReference: body.bankReference,
      recheckToken: body.recheckToken,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
