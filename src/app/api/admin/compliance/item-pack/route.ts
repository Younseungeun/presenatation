import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/server/db';
import { buildItemTeacherPack, ItemPackError } from '@/server/itemTeacherPackService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

// 검출 항목별 질문지 (2026-09-01) — 검출 항목 관리 표에서 사람이 펼친 항목 하나를 지연 로드한다.
// 사건별 질문지(/ask)와 달리 저장하지 않는다 — 답이 재학습 라벨이 아니라 코드 조건 초안이라
// 부를 때마다 현재 증거로 새로 만든다.

export async function GET(req: NextRequest) {
  try {
    await requireOperatorId(prisma);
    const item = req.nextUrl.searchParams.get('item');
    if (!item) return NextResponse.json({ error: 'item 이 필요합니다' }, { status: 400 });
    return NextResponse.json(await buildItemTeacherPack(prisma, item));
  } catch (e) {
    if (e instanceof ItemPackError) return NextResponse.json({ error: e.message }, { status: 400 });
    return toErrorResponse(e);
  }
}
