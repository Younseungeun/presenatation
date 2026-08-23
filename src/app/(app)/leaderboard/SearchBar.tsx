"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { buildQueryString, parseCardQuery, TAG_GROUPS, toggleTag } from "@/domain/cardQuery";
import styles from "./leaderboard.module.css";

// 카드 검색창.
//
// 태그는 **검색창 안에 항목으로 쌓인다** — 누르는 즉시 검색이 실행되면 조건을 겹쳐 쓸 수
// 없다(교집합이 이 검색의 핵심이다). 쌓아 놓고 마지막에 한 번 검색한다.
//
// 펼침 패널은 전체 태그를 범주별로 보여준다. 가로 스크롤은 "더 있다"는 사실을 숨겨서,
// 쓸 줄 모르는 사람에게 정작 필요한 목록이 화면 밖에 남는다.
// 펼치는 동안 뒤를 어둡게 덮는 이유도 같다 — 이 순간의 일은 조건을 고르는 것 하나다.
// 스크림을 누르면 닫힌다 (조건은 버리지 않는다 — 실수로 닫아도 다시 열면 그대로).
//
// 검색어는 URL(?q=)로 남는다. 뒤로가기로 복원되고 링크로 공유된다.
//
// 검색줄(유리 바)째로 이 컴포넌트가 그린다 — 열림 상태가 줄의 z-층을 스크림 위로
// 올려야 해서다(cart 버튼도 같은 줄에 있으니 함께 밝게 남는다).

export function SearchBar({ initial, cart }: { initial: string; cart?: React.ReactNode }) {
  const router = useRouter();
  // URL의 검색어를 이름과 태그로 되돌려 놓는다 — 새로고침해도 칩이 그대로 남는다
  const parsed = parseCardQuery(initial);
  const initialTags = initial.split("#").slice(1).map((t) => `#${t.trim()}`);

  const [text, setText] = useState(parsed.text);
  const [tags, setTags] = useState<string[]>(initial ? initialTags : []);
  const [open, setOpen] = useState(false);

  // 스크롤은 잠그지 않는다. 예전(검색줄이 static일 때)에는 열린 채 스크롤하면 패널이
  // 화면 밖으로 떠내려가서 body를 잠갔는데, 그 잠금이 body를 스크롤 컨테이너로 만들어
  // sticky를 깨뜨렸다 — 검색줄이 문서 맨 위 원위치로 돌아가 "열면 위로 튀는" 원인.
  // (html에 걸면 이번엔 스크롤 오프셋이 0으로 붙는다.) 지금은 줄이 sticky라 열린 채
  // 스크롤해도 검색줄·패널·스크림이 전부 상단에 붙어 따라오므로 잠글 이유가 없다.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function submit(nextText: string, nextTags: string[]) {
    const q = buildQueryString(nextText, nextTags);
    setOpen(false);
    router.push(q ? `/leaderboard?q=${encodeURIComponent(q)}` : "/leaderboard");
  }

  function onTagClick(tag: string) {
    // 누른 즉시 검색하지 않는다 — 조건을 겹쳐 고를 수 있어야 교집합이 성립한다
    setTags((prev) => toggleTag(prev, tag));
  }

  function clearAll() {
    setText("");
    setTags([]);
    submit("", []);
  }

  const empty = !text.trim() && tags.length === 0;

  return (
    <div className={`${styles.searchRow} ${open ? styles.searchRowOpen : ""}`}>
    <div className={styles.searchWrap}>
      <form
        className={`${styles.searchForm} ${open ? styles.searchFormOpen : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          submit(text, tags);
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

        {/* 고른 태그가 검색창 안에 항목으로 쌓인다 */}
        <span className={styles.searchField}>
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={styles.searchTag}
              onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
              aria-label={`${tag} 조건 빼기`}
            >
              {tag}
              <span className={styles.searchTagX} aria-hidden="true">
                ✕
              </span>
            </button>
          ))}
          <input
            className={styles.searchInput}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              // 빈 입력에서 백스페이스 → 마지막 태그부터 지운다 (메일 수신자 입력과 같은 관습)
              if (e.key === "Backspace" && text === "" && tags.length > 0) {
                setTags((prev) => prev.slice(0, -1));
              }
            }}
            placeholder={tags.length > 0 ? "리서처 이름" : "리서처 이름, #상승 #무위험"}
            aria-label="카드 검색"
            enterKeyHint="search"
          />
        </span>

        {!empty && (
          <button
            type="button"
            className={styles.searchClear}
            onClick={clearAll}
            aria-label="검색 조건 모두 지우기"
          >
            ✕
          </button>
        )}
      </form>

      {open && (
        <>
          {/* 뒤를 덮어 조건 고르기에 집중시킨다. 누르면 닫힌다.
              **포털로 body에 그린다** — 검색줄의 유리(backdrop-filter)가 fixed의 기준을
              줄 상자로 가로채서, 줄 안에 두면 스크림이 줄 크기만큼만 그려진다 */}
          {createPortal(
            <button
              type="button"
              className={styles.searchScrim}
              aria-label="검색 닫기"
              onClick={() => setOpen(false)}
            />,
            document.body,
          )}

          <div className={styles.tagPanel} role="dialog" aria-label="검색 조건">
            <div className={styles.tagPanelHead}>
              <span className={styles.tagPanelTitle}>조건을 겹쳐 고를 수 있어요</span>
              {tags.length > 0 && (
                <button
                  type="button"
                  className={styles.tagPanelReset}
                  onClick={() => setTags([])}
                >
                  조건 비우기
                </button>
              )}
            </div>

            <div className={styles.tagPanelBody}>
              {TAG_GROUPS.map((group) => (
                <div key={group.axis} className={styles.tagGroup}>
                  <div className={styles.tagGroupTitle}>
                    {group.title}
                    {group.multi && <span className={styles.tagGroupNote}>여러 개 선택</span>}
                  </div>
                  <div className={styles.tagGroupTags}>
                    {group.tags.map(({ tag, hint }) => (
                      <button
                        key={tag}
                        type="button"
                        className={`${styles.tagOption} ${
                          tags.includes(tag) ? styles.tagOptionOn : ""
                        }`}
                        onClick={() => onTagClick(tag)}
                        aria-pressed={tags.includes(tag)}
                        title={hint || undefined}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className={styles.tagPanelFoot}>
              <button
                type="button"
                className={styles.tagPanelApply}
                onClick={() => submit(text, tags)}
              >
                {tags.length > 0 ? `조건 ${tags.length}개로 검색` : "검색"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>

    {cart}
    </div>
  );
}
