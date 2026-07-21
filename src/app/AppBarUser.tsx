"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

// 앱바 우측 로그인 상태. 로그아웃은 API 호출 후 새로고침.
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
  const linkStyle = { fontSize: 14, fontWeight: 600, color: "var(--text-weak)" };

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/");
    router.refresh();
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <Link href="/leaderboard" style={linkStyle}>
        리더보드
      </Link>
      <Link href="/purchases" style={linkStyle}>
        구매 내역
      </Link>
      <Link href="/notifications" style={{ ...linkStyle, position: "relative" }}>
        알림
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: -7,
              right: -14,
              minWidth: 16,
              height: 16,
              padding: "0 4px",
              borderRadius: 8,
              background: "var(--brand-strong)",
              color: "#fff",
              fontSize: 10.5,
              fontWeight: 800,
              lineHeight: "16px",
              textAlign: "center",
            }}
          >
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </Link>
      {researcherId ? (
        <Link href={`/researcher/${researcherId}`} style={linkStyle}>
          내 리포트
        </Link>
      ) : (
        <Link href="/researcher/start" style={linkStyle}>
          리서처 되기
        </Link>
      )}
      <span style={{ fontSize: 14, fontWeight: 700 }}>{penName ?? "회원"}</span>
      <button
        onClick={logout}
        style={{ ...linkStyle, background: "none", border: "none", cursor: "pointer" }}
      >
        로그아웃
      </button>
    </div>
  );
}
