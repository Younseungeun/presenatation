"use client";

import { usePathname } from "next/navigation";

// **로그인 화면에선 안을 숨긴다** (판정 팝업 + 하단 탭바). 2026-08-29 사용자 지시.
//
// children 으로 받는 것이 핵심이다 — 여기서 FloatingHost/BottomNav 를 직접 import 하면
// 그 서버 전용 의존성(session.ts → next/headers)이 클라이언트 그래프로 딸려와 빌드가
// 터진다. 서버 레이아웃이 렌더한 요소를 children 으로 받아 경로로만 가른다.
export function HideOnLogin({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login") return null;
  return <>{children}</>;
}
