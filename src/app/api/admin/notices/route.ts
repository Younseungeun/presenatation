import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { NOTICE_AUDIENCES, NOTICE_BODY_MAX, NOTICE_TITLE_MAX } from '@/domain/notice';
import { prisma } from '@/server/db';
import { NoticeError, sendNotice } from '@/server/noticeService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 공지 발송. 내용 규칙(금지 표현·길이)은 domain/notice.ts가 정하고
// 서비스가 다시 검사한다 — 여기 zod는 형식만 본다. 두 곳에서 같은 판단을 하면
// 언젠가 갈라지므로, **거절할 권한은 도메인에만** 둔다.

const bodySchema = z.object({
  title: z.string().min(1).max(NOTICE_TITLE_MAX),
  body: z.string().min(1).max(NOTICE_BODY_MAX),
  audience: z.enum(NOTICE_AUDIENCES),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const input = bodySchema.parse(await req.json());
    const { notice, recipients } = await sendNotice(prisma, { ...input, operatorUserId });
    return NextResponse.json({ ok: true, id: notice.id, recipients });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message ?? '요청 형식 오류' }, { status: 400 });
    }
    if (e instanceof NoticeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
