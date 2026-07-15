import { NextResponse } from 'next/server';
import { DEMO_USER_COOKIE } from '@/server/currentUser';
import { prisma } from '@/server/db';

// 개발용: 데모 구매자를 보장하고 쿠키로 신원을 설정한다 (실제 로그인 대체 스텁).
export async function POST() {
  const buyer = await prisma.user.upsert({
    where: { email: 'demo-buyer@test.io' },
    update: {},
    create: { email: 'demo-buyer@test.io', penName: '데모구매자', identityVerified: true },
  });

  const res = NextResponse.json({ userId: buyer.id, penName: buyer.penName });
  res.cookies.set(DEMO_USER_COOKIE, buyer.id, {
    httpOnly: false,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
