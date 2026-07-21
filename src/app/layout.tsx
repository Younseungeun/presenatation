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
        <footer className="siteFooter">
          <div className="siteFooterInner">
            <nav className="siteFooterLinks">
              <Link href="/terms/TERMS_OF_SERVICE">이용약관</Link>
              <Link href="/terms/PRIVACY_POLICY">개인정보처리방침</Link>
              <Link href="/terms/RESEARCHER_AGREEMENT">리서처 이용계약</Link>
            </nav>
            <p className="siteFooterNote">
              본 서비스의 리포트는 공개 자료 기반 분석이며 투자권유가 아닙니다. 투자 판단과
              결과의 책임은 이용자 본인에게 있습니다.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
