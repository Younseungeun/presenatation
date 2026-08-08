"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SUGGESTED_TAGS } from "@/domain/cardQuery";
import styles from "./leaderboard.module.css";

// 카드 검색창.
//
// 검색어는 URL(?q=)로 남는다 — 뒤로가기로 이전 검색이 복원되고 링크로 공유된다.
// 클라이언트 상태는 입력 중인 글자와 추천 태그 펼침 여부뿐이다.
//
// 추천 태그를 늘 보여주지 않고 입력창을 눌렀을 때만 펼치는 이유: 이 태그들은 설명서다.
// 쓸 줄 아는 사람에게는 자리만 차지하고, 모르는 사람에게는 처음에 반드시 필요하다.

export function SearchBar({ initial }: { initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [focused, setFocused] = useState(false);

  function submit(next: string) {
    const q = next.trim();
    router.push(q ? `/leaderboard?q=${encodeURIComponent(q)}` : "/leaderboard");
  }

  /** 추천 태그는 지우고 넣는 게 아니라 덧붙인다 — 조건은 겹쳐 쓰는 것이기 때문 */
  function appendTag(tag: string) {
    const next = value.trim() ? `${value.trim()} ${tag}` : tag;
    setValue(next);
    submit(next);
  }

  return (
    <div className={styles.searchWrap}>
      <form
        className={styles.searchForm}
        onSubmit={(e) => {
          e.preventDefault();
          submit(value);
        }}
        role="search"
      >
        <svg
          className={styles.searchIcon}
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
          <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>

        <input
          className={styles.searchInput}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setFocused(true)}
          // 추천 태그를 누르는 동안 닫히지 않게 살짝 늦춘다
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          placeholder="리서처 이름, #국내주식 #상승 #신뢰도 4이상"
          aria-label="카드 검색"
          enterKeyHint="search"
        />

        {value && (
          <button
            type="button"
            className={styles.searchClear}
            onClick={() => {
              setValue("");
              submit("");
            }}
            aria-label="검색어 지우기"
          >
            ✕
          </button>
        )}
      </form>

      {(focused || initial) && (
        <div className={styles.tagHints}>
          {SUGGESTED_TAGS.map((s) => (
            <button
              key={s.tag}
              type="button"
              className={styles.tagHint}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => appendTag(s.tag)}
              title={s.hint}
            >
              {s.tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
