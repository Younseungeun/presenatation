import Link from "next/link";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { FloatingHost } from "./FloatingHost";
import { AppLaunch } from "./AppLaunch";
import { BottomNav } from "./BottomNav";
import { NavTracker } from "./NavTracker";
import { ScrollMemory } from "./ScrollMemory";

// 이용자 화면의 껍데기 — **여기 있는 것은 전부 이용자만 본다.**
//
// 이 파일이 뿌리(app/layout.tsx)가 아니라 (app) 묶음 안에 사는 이유가 곧 규칙이다:
// 판정 팝업·하단 탭바·약관 푸터는 리포트를 사고 파는 사람에게 필요한 장치이지,
// 큐를 처리하는 운영자에게는 남의 화면이다. 뿌리에 두면 /admin에도 따라붙어
// 관리 화면 바닥에 탭바가 둘, 그 위로 판정 팝업이 뜬다.
//
// 상단 헤더는 없다 — 하단 탭바(홈·리더보드·랭킹·MY)가 유일한 최상위 내비게이션이다.
// 로그인·로그아웃·알림·리서처 전환은 전부 MY 화면에 모여 있다((app)/my/page.tsx).
async function unreadNotificationCount(): Promise<number> {
  const userId = await getSessionUserId();
  if (!userId) return 0;
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const unreadCount = await unreadNotificationCount();

  return (
    <>
      <AppLaunch />
      <NavTracker />
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
      {/* 탭 화면 스크롤 위치 기억 — 다른 탭에 갔다 오면 보던 자리로 */}
      <ScrollMemory />
      {/* 진행 중인 판정 팝업 — 홈·리더보드·랭킹 어디서나 유지된다 (MY에서는 숨김) */}
      <FloatingHost />
      <BottomNav unreadCount={unreadCount} />
    </>
  );
}
