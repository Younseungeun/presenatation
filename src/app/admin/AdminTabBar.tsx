"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AdminIcon } from "./AdminIcons";
import styles from "./admin.module.css";

// 관리자 하단 탭바 — **5화면 구조** (시안 v3에서 확정, 2026-08-19 앱 이식).
//
// 분류 축은 **"이 일을 끝내려면 무엇을 봐야 하는가"**:
//   규정집·본문이면 리포트 · 은행 앱이면 돈 · 그 사람의 이력이면 보안 · 서버면 상태.
// 이전에는 관리 화면이 9개였고 전부 대시보드의 링크 목록으로만 닿았다 — 목록은
// "무엇이 있나"는 알려주지만 "어디로 가야 하나"는 답하지 못한다.
//
// **한 화면이 여러 경로를 가진다** (예: 돈 = 지급·환불 + 이의). `match`가 그 경로
// 전부를 한 탭에 묶는다 — 탭은 URL이 아니라 **일의 종류**를 가리킨다.

export interface TabCounts {
  report: number;
  money: number;
  sec: number;
  status: number;
}

type Tone = "neg" | "warn" | "calm";

const TABS: Array<{
  key: keyof TabCounts | "home";
  href: string;
  label: string;
  icon: React.ReactNode;
  match: (p: string) => boolean;
}> = [
  { key: "home", href: "/admin", label: "홈", icon: AdminIcon.home, match: (p) => p === "/admin" },
  {
    key: "report",
    href: "/admin/compliance",
    label: "리포트",
    icon: AdminIcon.report,
    match: (p) =>
      p.startsWith("/admin/compliance") ||
      p.startsWith("/admin/judgments") ||
      p.startsWith("/admin/detection"),
  },
  {
    key: "money",
    href: "/admin/settlements",
    label: "돈",
    icon: AdminIcon.money,
    match: (p) => p.startsWith("/admin/settlements") || p.startsWith("/admin/disputes"),
  },
  {
    key: "sec",
    href: "/admin/frozen",
    label: "보안",
    icon: AdminIcon.sec,
    match: (p) => p.startsWith("/admin/frozen") || p.startsWith("/admin/approvals"),
  },
  {
    key: "status",
    href: "/admin/health",
    label: "상태",
    icon: AdminIcon.status,
    match: (p) => p.startsWith("/admin/health") || p.startsWith("/admin/settings"),
  },
];

/** 배지 색 — 색 축과 같다: 빨강 = 지금 안 하면 심대, 노랑 = 여유는 있다, 회색 = 조용함 */
const TONE_CLASS: Record<Tone, string> = {
  neg: styles.badge,
  warn: `${styles.badge} ${styles.badgeWarn}`,
  calm: `${styles.badge} ${styles.badgeCalm}`,
};

export function AdminTabBar({ counts, tones }: { counts: TabCounts; tones: Record<keyof TabCounts, Tone> }) {
  const pathname = usePathname() ?? "/admin";

  return (
    <nav className={styles.tabbar} aria-label="관리 화면 전환">
      {TABS.map((t) => {
        const on = t.match(pathname);
        const count = t.key === "home" ? 0 : counts[t.key];
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`${styles.tabItem} ${on ? styles.tabItemOn : ""}`}
            aria-current={on ? "page" : undefined}
          >
            {count > 0 && t.key !== "home" && (
              <span className={TONE_CLASS[tones[t.key]]}>{count}</span>
            )}
            <span className={styles.tabIcon}>{t.icon}</span>
            <span className={styles.tabLabel}>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
