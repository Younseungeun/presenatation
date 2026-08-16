import { Prisma, type PrismaClient } from '@prisma/client';
import { NextResponse, type NextRequest } from 'next/server';
import { PublishValidationError } from '@/domain/publishReport';
import { ComplianceTakedownError } from '@/server/complianceService';
import { ManualJudgmentError } from '@/server/manualJudgmentService';
import { SettlementOpsError } from '@/server/settlementOpsService';
import { getSessionUserId } from '@/server/session';
import { CHECKOUT_RULE, hitRateLimit, type RateLimitRule } from '@/server/rateLimit';

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

/**
 * 결제를 유발하는 엔드포인트의 호출 제한. 넘으면 429로 던진다.
 *
 * **사용자와 IP 둘 다 센다.** 계정 하나로 두드리는 것은 사용자 키가 막고, 계정을
 * 여러 개 만들어 두드리는 것은 IP 키가 막는다 — 카드 테스팅은 보통 후자다.
 * (본인 인증이 1인 1계정을 강제하고 있지만, 인증 공급자가 아직 스텁이라
 *  그 방어선 하나에 기대면 안 된다)
 */
export function enforceCheckoutRate(
  req: NextRequest,
  userId: string,
  rule: RateLimitRule = CHECKOUT_RULE,
): void {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  for (const [bucket, key] of [
    ['checkout:user', userId],
    ['checkout:ip', ip],
  ] as const) {
    const r = hitRateLimit(bucket, key, rule);
    if (!r.ok) {
      throw new HttpError(
        429,
        `결제 요청이 너무 잦습니다. ${Math.ceil(r.retryAfterMs / 1000)}초 후 다시 시도해주세요.`,
      );
    }
  }
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
  if (e instanceof ManualJudgmentError) {
    // code(RECHECK_REQUIRED)가 있으면 화면이 지문·얼굴 확인을 띄우고 재시도한다
    return NextResponse.json({ error: e.message, code: e.code }, { status: 400 });
  }
  if (e instanceof SettlementOpsError || e instanceof ComplianceTakedownError) {
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
