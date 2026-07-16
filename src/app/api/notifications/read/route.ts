import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { markAllNotificationsRead } from '@/server/notificationService';
import { requireUserId, toErrorResponse } from '../../_lib/http';

/** 알림 전체 읽음 처리 — 알림함 열람 시 클라이언트가 호출 */
export async function POST() {
  try {
    const userId = await requireUserId();
    const marked = await markAllNotificationsRead(prisma, userId);
    return NextResponse.json({ marked });
  } catch (e) {
    return toErrorResponse(e);
  }
}
