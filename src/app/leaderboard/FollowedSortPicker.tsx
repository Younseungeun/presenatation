"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  FOLLOWED_CARD_SORTS,
  FOLLOWED_CARD_SORT_LABEL,
  type FollowedCardSort,
} from "@/server/marketQueries";
import styles from "./leaderboard.module.css";

// 팔로우 레일의 카드 정렬 — 홈 히트맵의 자산군 버튼과 같은 인라인 드롭다운.
// 시트도 팝업도 아니고 버튼 자리에서 바로 아래로 펼친다: 고르는 값이 셋뿐이라
// 화면을 덮을 이유가 없고, 아이브로우("무슨 순서로 나열됐나")가 곧 버튼이 된다.
//
// 선택은 URL(?fsort=)로 남는다 — 서버가 정렬하므로 새로고침·뒤로가기·공유가
// 그대로 동작하고, 클라이언트가 드는 상태는 열림 여부 하나뿐이다.
// scroll={false}: 정렬은 보던 자리에서 바뀌어야 한다 (리더보드 필터와 같은 규칙).

export function FollowedSortPicker({
  sort,
  hrefs,
}: {
  sort: FollowedCardSort;
  /**
   * 정렬별 URL — 화면마다 유지해야 할 쿼리가 달라 부모가 만들어 준다.
   * 함수가 아니라 만들어진 값으로 받는다: 서버 컴포넌트는 클라이언트 컴포넌트에
   * 함수를 넘길 수 없다(직렬화 불가). 어차피 경우의 수가 셋뿐이라 미리 만들면 된다
   */
  hrefs: Record<FollowedCardSort, string>;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // 바깥을 누르거나 Esc면 닫는다 — 열어 둔 채 다른 곳을 만지면 길을 잃는다
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className={styles.fsortWrap}>
      <button
        type="button"
        className={styles.fsortBtn}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`카드 정렬 — 현재 ${FOLLOWED_CARD_SORT_LABEL[sort]}`}
      >
        {FOLLOWED_CARD_SORT_LABEL[sort]}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
          className={open ? styles.fsortChevronUp : undefined}
        >
          <path
            d="M6 9l6 6 6-6"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <span className={styles.fsortMenu}>
          {FOLLOWED_CARD_SORTS.filter((s) => s !== sort).map((s) => (
            <Link
              key={s}
              href={hrefs[s]}
              scroll={false}
              className={styles.fsortOption}
              onClick={() => setOpen(false)}
            >
              {FOLLOWED_CARD_SORT_LABEL[s]}
            </Link>
          ))}
        </span>
      )}
    </span>
  );
}
