"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

// 앱바 우측 로그인 상태.
// - 데스크톱: 링크를 가로로 나열
// - 모바일: 알림 미읽음 뱃지를 단 햄버거 버튼 → 드롭다운 시트
export function AppBarUser({
  penName,
  researcherId,
  unreadCount,
}: {
  penName: string | null;
  researcherId: string | null;
  unreadCount: number;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  async function logout() {
    setMenuOpen(false);
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  const links = (
    <>
      <Link href="/leaderboard" className="navLink" onClick={() => setMenuOpen(false)}>
        리더보드
      </Link>
      <Link href="/purchases" className="navLink" onClick={() => setMenuOpen(false)}>
        구매 내역
      </Link>
      <Link href="/notifications" className="navLink navNoti" onClick={() => setMenuOpen(false)}>
        알림
        {unreadCount > 0 && <span className="navBadge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </Link>
      {researcherId ? (
        <Link href={`/researcher/${researcherId}`} className="navLink" onClick={() => setMenuOpen(false)}>
          내 리포트
        </Link>
      ) : (
        <Link href="/researcher/start" className="navLink" onClick={() => setMenuOpen(false)}>
          리서처 되기
        </Link>
      )}
    </>
  );

  return (
    <>
      {/* 데스크톱 */}
      <nav className="navDesktop">
        {links}
        <span className="navName">{penName ?? "회원"}</span>
        <button onClick={logout} className="navLink navBtn">
          로그아웃
        </button>
      </nav>

      {/* 모바일 */}
      <button
        className="navToggle"
        aria-label="메뉴"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <span className="navToggleBars" />
        {unreadCount > 0 && !menuOpen && <span className="navBadge navToggleBadge">{unreadCount > 99 ? "99+" : unreadCount}</span>}
      </button>
      {menuOpen && (
        <>
          <button className="navScrim" aria-label="닫기" onClick={() => setMenuOpen(false)} />
          <div className="navSheet">
            <div className="navSheetName">{penName ?? "회원"}</div>
            {links}
            <button onClick={logout} className="navLink navBtn navSheetLogout">
              로그아웃
            </button>
          </div>
        </>
      )}
    </>
  );
}
