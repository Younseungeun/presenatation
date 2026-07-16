import { Prisma, type PrismaClient } from '@prisma/client';
import { NextResponse } from 'next/server';
import { PublishValidationError } from '@/domain/publishReport';
import { ManualJudgmentError } from '@/server/manualJudgmentService';
import { SettlementOpsError } from '@/server/settlementOpsService';
import { getSessionUserId } from '@/server/session';

// API 공통: 세션 인증 + 에러 매핑

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 로그인 사용자 id (구매 등). 세션 없으면 401 */
export async function requireUserId(): Promise<string> {
  const userId = await getSessionUserId();
  if (!userId) throw new HttpError(401, '로그인이 필요합니다');
  return userId;
}

/** 운영자 사용자 id (판정 보류 큐 수동 판정). OPERATOR 아니면 403 */
export async function requireOperatorId(prisma: PrismaClient): Promise<string> {
  const userId = await requireUserId();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== 'OPERATOR') throw new HttpError(403, '운영자 권한이 필요합니다');
  return userId;
}

/** 로그인 사용자의 리서처 프로필 id (게시·철회). 프로필 없으면 403 */
export async function requireResearcherId(prisma: PrismaClient): Promise<string> {
  const userId = await requireUserId();
  const profile = await prisma.researcherProfile.findUnique({ where: { userId } });
  if (!profile) throw new HttpError(403, '리서처로 활동하려면 먼저 리서처 전환이 필요합니다');
  return profile.id;
}

const PRISMA_STATUS: Record<string, { status: number; message: string }> = {
  P2025: { status: 404, message: '리소스를 찾을 수 없습니다' },
  P2002: { status: 409, message: '이미 존재하는 요청입니다 (중복)' },
};

export function toErrorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  if (e instanceof PublishValidationError) {
    return NextResponse.json({ error: '검증 실패', issues: e.issues }, { status: 400 });
  }
  if (e instanceof ManualJudgmentError || e instanceof SettlementOpsError) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && PRISMA_STATUS[e.code]) {
    const { status, message } = PRISMA_STATUS[e.code];
    return NextResponse.json({ error: message }, { status });
  }
  if (e instanceof Error) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  return NextResponse.json({ error: '서버 오류' }, { status: 500 });
}
