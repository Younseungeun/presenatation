import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ASSET_CLASSES } from '@/domain/constants';
import { prisma } from '@/server/db';
import { setJudgmentPause } from '@/server/judgmentPause';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 자동 판정 정지·해제 (운영자).
//
// **사유가 필수다** — 왜 멈췄는지 모르면 언제 풀어야 하는지도 모른다.
// 정지는 보호적 행위라 화면에 둔다. 반대로 일괄 롤백은 파괴적이라 CLI에만 있다
// (세션 하나가 하루치 판정을 날리는 길을 만들지 않는다 — TOTP가 붙기 전까지).

const schema = z.object({
  scope: z.enum(['ALL', ...ASSET_CLASSES] as [string, ...string[]]),
  paused: z.boolean(),
  reason: z.string().min(2).max(500),
});

export async function PATCH(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = schema.parse(await req.json());
    await setJudgmentPause(prisma, {
      scope: body.scope as 'ALL',
      paused: body.paused,
      operatorUserId,
      reason: body.reason,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
