import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "리서치 마켓플레이스",
  description:
    "성과 검증형 리서치 마켓플레이스 — 예측이 시장 데이터로 자동 검증되는 리포트 플랫폼",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
            <Link
              href="/leaderboard"
              style={{ fontSize: 14, fontWeight: 600, color: "var(--text-weak)" }}
            >
              리더보드
            </Link>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
