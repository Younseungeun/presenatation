import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppBarUser } from "./AppBarUser";
import "./globals.css";

export const metadata: Metadata = {
  title: "리서치 마켓플레이스",
  description:
    "성과 검증형 리서치 마켓플레이스 — 예측이 시장 데이터로 자동 검증되는 리포트 플랫폼",
};

async function currentUser() {
  const userId = await getSessionUserId();
  if (!userId) return null;
  const [user, unreadCount] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { penName: true, researcherProfile: { select: { id: true } } },
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return user ? { ...user, unreadCount } : null;
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await currentUser();

  return (
    <html lang="ko">
      <body>
        <header className="appbar">
          <div className="appbarInner">
            <Link href="/" className="brandMark">
              <span className="brandDot" />
              리서치마켓
            </Link>
            <div style={{ flex: 1 }} />
            {user ? (
              <AppBarUser
                penName={user.penName}
                researcherId={user.researcherProfile?.id ?? null}
                unreadCount={user.unreadCount}
              />
            ) : (
              <Link
                href="/login"
                style={{ fontSize: 14, fontWeight: 700, color: "var(--brand-strong)" }}
              >
                로그인
              </Link>
            )}
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
