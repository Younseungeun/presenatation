import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./emptyState.module.css";

// 빈 상태 공통 컴포넌트 — 화면마다 제각각이던 한 줄 문구를
// "점선 실루엣 + 제목 + (설명) + (다음 행동)"의 한 가지 형태로 통일한다.
// 점선 상자는 "아직 채워지지 않은 자리"라는 뜻의 자리 표시 — 브랜드 민트를 옅게만 쓴다.
// 빈 상태는 막다른 길이 아니라 다음 행동의 입구다: 가능한 화면에는 action을 붙인다.

type Glyph = "card" | "doc" | "bell" | "rank" | "inbox";

const GLYPHS: Record<Glyph, ReactNode> = {
  /* 예측 카드 — 추세선이 그려질 자리 */
  card: (
    <svg width="22" height="22" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="3" y="3.5" width="14" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M6 12.5l2.8-3 2 2 3.2-3.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  /* 리포트 문서 */
  doc: (
    <svg width="22" height="22" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="4.5" y="2.5" width="11" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 7h5M7.5 10h5M7.5 13h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  /* 알림 종 */
  bell: (
    <svg width="22" height="22" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M10 3.2c-2.6 0-4.2 1.9-4.2 4.4v2.6L4.2 13h11.6l-1.6-2.8V7.6c0-2.5-1.6-4.4-4.2-4.4z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M8.4 15.6a1.6 1.6 0 003.2 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  /* 랭킹 막대 */
  rank: (
    <svg width="22" height="22" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5 16.5v-4.5M10 16.5V4.5M15 16.5V9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  ),
  /* 운영자 수신함 */
  inbox: (
    <svg width="22" height="22" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M5.2 4.5h9.6L17 11v3.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 013 14.5V11l2.2-6.5z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M3 11h4.2l1 1.8h3.6l1-1.8H17"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  ),
};

export function EmptyState({
  glyph = "card",
  title,
  body,
  actionHref,
  actionLabel,
  compact = false,
}: {
  glyph?: Glyph;
  title: string;
  body?: string;
  actionHref?: string;
  actionLabel?: string;
  /** 화면 안의 한 섹션이 비었을 때 — 여백과 실루엣을 줄인다 */
  compact?: boolean;
}) {
  return (
    <div className={`${styles.empty} ${compact ? styles.compact : ""}`}>
      <span className={styles.mark} aria-hidden>
        {GLYPHS[glyph]}
      </span>
      <strong className={styles.title}>{title}</strong>
      {body && <p className={styles.body}>{body}</p>}
      {actionHref && actionLabel && (
        <Link href={actionHref} className={styles.action}>
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
