"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 하단 탭바 — 모바일 전용 최상위 내비게이션 (홈·리더보드·랭킹·MY).
// 데스크톱(>720px)에서는 숨기고 앱바 내비게이션을 쓴다.

type Tab = {
  href: string;
  label: string;
  match: (path: string) => boolean;
  icon: (active: boolean) => React.ReactNode;
};

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const TABS: Tab[] = [
  {
    href: "/",
    label: "홈",
    match: (p) => p === "/",
    icon: (active) => (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path
          {...stroke}
          fill={active ? "currentColor" : "none"}
          fillOpacity={active ? 0.16 : 0}
          d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"
        />
      </svg>
    ),
  },
  {
    href: "/leaderboard",
    label: "리더보드",
    match: (p) => p.startsWith("/leaderboard"),
    icon: (active) => (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path
          {...stroke}
          fill={active ? "currentColor" : "none"}
          fillOpacity={active ? 0.16 : 0}
          d="M4 13h4v7H4zM10 8h4v12h-4zM16 11h4v9h-4z"
        />
        <path {...stroke} d="M4 4h16" opacity="0.4" />
      </svg>
    ),
  },
  {
    href: "/ranking",
    label: "랭킹",
    match: (p) => p.startsWith("/ranking"),
    icon: (active) => (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <path
          {...stroke}
          fill={active ? "currentColor" : "none"}
          fillOpacity={active ? 0.16 : 0}
          d="M12 4.5l2.2 4.5 4.8.7-3.5 3.4.85 4.9L12 15.7l-4.35 2.3.85-4.9L5 9.7l4.8-.7z"
        />
      </svg>
    ),
  },
  {
    href: "/my",
    label: "MY",
    match: (p) => p.startsWith("/my"),
    icon: (active) => (
      <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
        <circle
          {...stroke}
          cx="12"
          cy="8.5"
          r="3.6"
          fill={active ? "currentColor" : "none"}
          fillOpacity={active ? 0.16 : 0}
        />
        <path {...stroke} d="M4.8 20c.9-3.6 3.7-5.5 7.2-5.5s6.3 1.9 7.2 5.5" />
      </svg>
    ),
  },
];

export function BottomNav({ unreadCount }: { unreadCount: number }) {
  const pathname = usePathname() ?? "/";

  return (
    <nav className="tabbar" aria-label="주요 화면">
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`tabItem${active ? " tabItemActive" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            <span className="tabIcon">
              {t.icon(active)}
              {t.href === "/my" && unreadCount > 0 && (
                <span className="tabDot" aria-label={`읽지 않은 알림 ${unreadCount}건`} />
              )}
            </span>
            <span className="tabLabel">{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
