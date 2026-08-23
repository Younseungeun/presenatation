"use client";

import { useState } from "react";
import styles from "./leaderboard.module.css";

// 자산군별 목록의 "더 보기".
//
// 목록 전체를 한 번에 쏟으면 훑는 것이 아니라 스크롤이 된다. 앞의 몇 장은 정렬이
// 고른 상위라 의미가 있지만 그 뒤는 "그 외 전부"라, 보고 싶은 사람만 펼치면 된다.
//
// 나머지 카드는 **서버에서 이미 그려져** children으로 들어온다 — 펼침이 즉시 끝나고
// 정렬·필터·마스킹 로직이 클라이언트로 새지 않는다. 이 컴포넌트가 아는 것은 열림 여부뿐이다.

export function MoreCards({ count, children }: { count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  if (open) return <>{children}</>;

  return (
    <button type="button" className={styles.moreBtn} onClick={() => setOpen(true)}>
      카드 {count}장 더 보기
      <span className={styles.moreChevron} aria-hidden="true">
        ⌄
      </span>
    </button>
  );
}
