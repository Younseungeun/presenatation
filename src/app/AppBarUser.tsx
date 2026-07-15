"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

// 앱바 우측 로그인 상태. 로그아웃·리서처 전환은 API 호출 후 새로고침.
export function AppBarUser({
  penName,
  researcherId,
}: {
  penName: string | null;
  researcherId: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const linkStyle = { fontSize: 14, fontWeight: 600, color: "var(--text-weak)" };

  async function activate() {
    setBusy(true);
    const res = await fetch("/api/researcher/activate", { method: "POST" });
    const body = await res.json();
    setBusy(false);
    if (res.ok) {
      router.push(`/researcher/${body.researcherId}`);
      router.refresh();
    }
  }

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
      {researcherId ? (
        <Link href={`/researcher/${researcherId}`} style={linkStyle}>
          내 리포트
        </Link>
      ) : (
        <button
          onClick={activate}
          disabled={busy}
          style={{ ...linkStyle, background: "none", border: "none", cursor: "pointer" }}
        >
          리서처 되기
        </button>
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
