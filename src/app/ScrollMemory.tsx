"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";

// 탭 화면 스크롤 위치 기억 — 홈에서 아래로 내려간 상태로 다른 탭에 갔다가 돌아오면
// 보던 자리로 되돌린다 (앱에서 탭 전환의 기본 기대치).
//
// Next.js 기본 동작은 새 경로로 이동할 때 맨 위로 올리는 것이라, 경로별 위치를
// sessionStorage에 적어두고 복귀 시 되돌린다. 브라우저 뒤로가기(popstate)는 브라우저의
// 기본 복원이 이미 동작하므로 건드리지 않는다.
//
// 되돌릴 위치는 이번 방문에만 유지한다 — 앱을 새로 열면 맨 위에서 시작하는 편이 자연스럽다.

const KEY = "rm.scroll.v1";

/** 위치를 기억할 화면 — 목록이 길고 탭으로 오가는 최상위 탭 화면만 */
const REMEMBERED = ["/", "/leaderboard", "/ranking", "/my"];

function readAll(): Record<string, number> {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
    return typeof raw === "object" && raw !== null ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

export function ScrollMemory() {
  const pathname = usePathname() ?? "/";

  useEffect(() => {
    if (!REMEMBERED.includes(pathname)) return;

    // 복귀: 저장된 위치로. 콘텐츠가 다 그려진 뒤라야 그 높이까지 스크롤된다
    const saved = readAll()[pathname];
    let restoreTimer = 0;
    if (saved > 0) {
      const restore = () => window.scrollTo(0, saved);
      restore();
      requestAnimationFrame(restore);
      restoreTimer = window.setTimeout(restore, 120);
    }

    // 이탈 대비: 스크롤 중에는 간격을 두고, 멈춘 뒤에는 한 번 더 적어 마지막 위치를 남긴다
    // (requestAnimationFrame은 화면이 그려지지 않는 상황에서 안 돌아 시각에 기대지 않는다)
    const save = () => {
      const all = readAll();
      all[pathname] = window.scrollY;
      try {
        sessionStorage.setItem(KEY, JSON.stringify(all));
      } catch {
        // 저장 공간이 막힌 환경에서는 기억 없이 동작한다
      }
    };
    let lastSaved = 0;
    let trailing = 0;
    const onScroll = () => {
      const now = Date.now();
      if (now - lastSaved >= 120) {
        lastSaved = now;
        save();
      }
      window.clearTimeout(trailing);
      trailing = window.setTimeout(save, 150);
    };
    window.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.clearTimeout(restoreTimer);
      window.clearTimeout(trailing);
    };
  }, [pathname]);

  return null;
}
