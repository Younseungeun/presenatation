"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./leaderboard.module.css";

// 리더보드 고정 토글.
//
// 팔로우가 늘면 최신순만으로는 "늘 보고 싶은 사람"이 아래로 밀린다. 고정은 그 순서를
// 본인이 직접 정하는 장치다 — 알고리즘이 정해주는 것이 아니라.
//
// PR 블록 머리(프로필 링크) 안에 두면 링크가 중첩되므로 형제로 놓고 위에 겹친다.

export function PinButton({
  researcherId,
  pinned,
  name,
}: {
  researcherId: string;
  pinned: boolean;
  name: string;
}) {
  const router = useRouter();
  const [on, setOn] = useState(pinned);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setOn(next); // 눌린 즉시 반영하고 실패하면 되돌린다
    try {
      const res = await fetch(`/api/follows/${researcherId}/pin`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pinned: next }),
      });
      if (!res.ok) throw new Error();
      router.refresh();
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={`${styles.pin} ${on ? styles.pinOn : ""}`}
      onClick={toggle}
      disabled={busy}
      aria-pressed={on}
      aria-label={on ? `${name} 고정 해제` : `${name} 리더보드에 고정`}
      title={on ? "고정 해제" : "리더보드에 고정"}
    >
      {/* 압정 — 꽂힌 상태는 채워지고, 아닌 상태는 윤곽만 */}
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M14.5 2.5l7 7-2.1 2.1-1.4-.4-3.2 3.2.5 3.4-1.8 1.8-4-4-4.3 4.3-1.1-1.1L8.4 14.5l-4-4 1.8-1.8 3.4.5L12.8 6l-.4-1.4z"
          fill={on ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
