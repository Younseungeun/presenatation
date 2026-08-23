import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { NOTICE_BODY_MAX, NOTICE_BODY_MIN, NOTICE_TITLE_MAX } from '@/domain/notice';
import { prisma } from '@/server/db';
import { NoticeError, sendDirectNotice } from '@/server/noticeService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

// 한 사람에게만 보내는 쪽지 — 전체 공지와 **같은 규칙**을 탄다 (noticeService 주석 참조).
// 길이 상한도 공지와 같은 상수를 쓴다: 알림함에 뜨는 모양이 같으므로 다른 자를 대면
// 한쪽에서만 잘리는 글이 생긴다.
const bodySchema = z.object({
  userId: z.string().min(1),
  title: z.string().min(1).max(NOTICE_TITLE_MAX),
  body: z.string().min(NOTICE_BODY_MIN).max(NOTICE_BODY_MAX),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const input = bodySchema.parse(await req.json());
    await sendDirectNotice(prisma, { ...input, operatorUserId });
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof NoticeError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        {
          error: `제목은 ${NOTICE_TITLE_MAX}자, 본문은 ${NOTICE_BODY_MIN}~${NOTICE_BODY_MAX}자로 써 주세요`,
        },
        { status: 400 },
      );
    }
    return toErrorResponse(e);
  }
}
