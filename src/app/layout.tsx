import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "INTOVILL",
  description:
    "인투빌(INTOVILL) — 성과 검증형 리서치 마켓플레이스. 예측이 시장 데이터로 자동 검증되는 리포트 플랫폼",
  icons: { icon: "/icon.svg", apple: "/apple-touch-icon.png" },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "INTOVILL" },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  viewportFit: "cover",
};

// 앱 전체의 **뿌리** — html·body와 색·글꼴 토큰까지만 담는다.
//
// 여기에 화면 장치를 하나라도 두면 그것은 **모든 화면에 붙는다.** 이용자 화면과
// 관리 화면은 같은 코드베이스에 살 뿐 서로 다른 화면이고, 쓰는 사람도 다르다 —
// 판정 팝업·하단 탭바·약관 푸터는 이용자가 보라고 만든 것이지 운영자가 볼 것이
// 아니다. 그래서 껍데기를 둘로 나눠 뒀다:
//
//   (app)/layout.tsx    이용자 화면 — 실행 애니메이션·하단 탭바·판정 팝업·약관 푸터
//   admin/layout.tsx    관리 화면   — 패스키 관문·5탭 껍데기
//
// 둘은 형제다. 관리 화면이 이용자 껍데기 **위에 덧입혀지는 것이 아니다.**
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
