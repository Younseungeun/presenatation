"use client";

import { Children, useState } from "react";
import s from "./my.module.css";

/**
 * 처음엔 limit개만 보여주고 나머지는 버튼을 눌러 펼치는 목록.
 * 항목 자체는 서버에서 렌더된 채로 children으로 받는다 — 여기는 표시 개수만 관리한다.
 * 탭·모드를 바꾸면 URL이 바뀌며 다시 마운트되므로 자동으로 접힌 상태로 돌아간다.
 */
export function CollapsedList({
  children,
  limit = 3,
}: {
  children: React.ReactNode;
  limit?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const items = Children.toArray(children);
  const hidden = items.length - limit;

  return (
    <>
      {expanded ? items : items.slice(0, limit)}
      {!expanded && hidden > 0 && (
        <button type="button" className={s.showMore} onClick={() => setExpanded(true)}>
          나머지 {hidden}건 보기
        </button>
      )}
    </>
  );
}
