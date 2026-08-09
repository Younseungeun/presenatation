"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { bumpNavDepth } from "./navHistory";

// 루트 레이아웃에 한 번 놓는 이동 깊이 추적기 — 화면에는 아무것도 그리지 않는다.
// pathname이 바뀔 때마다(첫 화면 포함) 깊이를 1 올린다. SmartBackLink가 이 깊이로
// "뒤로가 앱 안에 착지하는가"를 판단한다.

export function NavTracker() {
  const pathname = usePathname();
  useEffect(() => {
    bumpNavDepth();
  }, [pathname]);
  return null;
}
