import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  SUPPORT_DETAIL_MAX,
  SUPPORT_DETAIL_MIN,
  SUPPORT_TOPICS,
} from '@/domain/supportTopics';
import { prisma } from '@/server/db';
import { createSupportTicket } from '@/server/supportService';
import { requireUserId, toErrorResponse } from '../_lib/http';

// 문의 접수 — 로그인 사용자만.
//
// **주제는 열거형이다.** 자유 문자열로 두면 화면을 우회해 아무 주제나 보낼 수 있고,
// 그러면 "주제를 정해 둔다"는 이 창구의 유일한 방어가 클라이언트 신뢰로 내려간다.
// 화면의 체크박스(기타 경고)는 안내이고, 진짜 경계는 이 열거형이다.

const bodySchema = z.object({
  topic: z.enum(SUPPORT_TOPICS),
  detail: z
    .string()
    .min(SUPPORT_DETAIL_MIN, `문의 내용을 ${SUPPORT_DETAIL_MIN}자 이상 적어 주세요`)
    .max(SUPPORT_DETAIL_MAX),
});

export async function POST(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = bodySchema.parse(await req.json());
    const created = await createSupportTicket(prisma, { userId, ...body });
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues[0]?.message ?? '요청 형식 오류' },
        { status: 400 },
      );
    }
    return toErrorResponse(e);
  }
}
