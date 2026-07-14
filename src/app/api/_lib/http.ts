import { Prisma } from '@prisma/client';
import { NextResponse, type NextRequest } from 'next/server';
import { PublishValidationError } from '@/domain/publishReport';

// API 공통: 인증 스텁 + 에러 매핑

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * 헤더 기반 인증 스텁 — 본인 인증(1인 1계정) 구현 전까지 사용.
 * TODO: 세션 기반 인증으로 교체 (CLAUDE.md 6.3절 7번)
 */
function requireHeader(req: NextRequest, name: string): string {
  const value = req.headers.get(name);
  if (!value) {
    throw new HttpError(401, `${name} 헤더가 필요합니다 (인증 스텁)`);
  }
  return value;
}

/** 리서처 식별 (리포트 게시·철회) */
export const requireResearcherId = (req: NextRequest) => requireHeader(req, 'x-researcher-id');

/** 사용자 식별 (구매) */
export const requireUserId = (req: NextRequest) => requireHeader(req, 'x-user-id');

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
  if (e instanceof Prisma.PrismaClientKnownRequestError && PRISMA_STATUS[e.code]) {
    const { status, message } = PRISMA_STATUS[e.code];
    return NextResponse.json({ error: message }, { status });
  }
  if (e instanceof Error) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  return NextResponse.json({ error: '서버 오류' }, { status: 500 });
}
