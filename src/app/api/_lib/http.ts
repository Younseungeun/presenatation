import { Prisma } from '@prisma/client';
import { NextResponse, type NextRequest } from 'next/server';
import { PublishValidationError } from '@/domain/publishReport';

// API 공통: 인증 스텁 + 에러 매핑

/**
 * 인증 스텁 — 본인 인증(1인 1계정) 구현 전까지 헤더로 리서처를 식별한다.
 * TODO: 세션 기반 인증으로 교체 (CLAUDE.md 6.3절 7번)
 */
export function requireResearcherId(req: NextRequest): string {
  const id = req.headers.get('x-researcher-id');
  if (!id) {
    throw new HttpError(401, 'x-researcher-id 헤더가 필요합니다 (인증 스텁)');
  }
  return id;
}

/**
 * 구매자 인증 스텁 — 본인 인증 구현 전까지 헤더로 사용자를 식별한다.
 * TODO: 세션 기반 인증으로 교체 (CLAUDE.md 6.3절 7번)
 */
export function requireUserId(req: NextRequest): string {
  const id = req.headers.get('x-user-id');
  if (!id) {
    throw new HttpError(401, 'x-user-id 헤더가 필요합니다 (인증 스텁)');
  }
  return id;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function toErrorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  if (e instanceof PublishValidationError) {
    return NextResponse.json({ error: '검증 실패', issues: e.issues }, { status: 400 });
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
    return NextResponse.json({ error: '리소스를 찾을 수 없습니다' }, { status: 404 });
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    return NextResponse.json({ error: '이미 존재하는 요청입니다 (중복)' }, { status: 409 });
  }
  if (e instanceof Error) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  return NextResponse.json({ error: '서버 오류' }, { status: 500 });
}
