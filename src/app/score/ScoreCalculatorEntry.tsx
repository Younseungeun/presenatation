import Link from "next/link";
import styles from "./score.module.css";

// 계산기 진입 배너.
//
// 두 자리에 놓는다:
//  · 랭킹 — 점수의 *결과*가 나열되는 유일한 화면이라 "이 숫자는 어떻게 나왔나"라는
//    질문이 생기는 자리다. 구매자에게는 순위가 조작 가능한지 확인시키는 경로다
//  · 리포트 작성 — 리서처가 신뢰도·안정성을 실제로 고르는 순간. 설명이 필요한 지점과
//    설명이 있는 지점이 같아야 읽힌다
// 문구가 자리마다 달라야 하므로 title·sub을 받는다.

export function ScoreCalculatorEntry({
  title,
  sub,
}: {
  title: string;
  sub: string;
}) {
  return (
    <Link href="/score" className={styles.entry}>
      <span className={styles.entryIcon}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect
            x="4"
            y="2.5"
            width="16"
            height="19"
            rx="3"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path d="M8 7h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path
            d="M8.5 12h.01M12 12h.01M15.5 12h.01M8.5 16h.01M12 16h.01M15.5 16h.01"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      </span>
      <span className={styles.entryMain}>
        <span className={styles.entryTitle}>{title}</span>
        <span className={styles.entrySub}>{sub}</span>
      </span>
      <span className={styles.entryArrow} aria-hidden="true">
        ›
      </span>
    </Link>
  );
}
