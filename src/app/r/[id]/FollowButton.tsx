"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import styles from "./followButton.module.css";

// 팔로우 토글 — 상태를 낙관적으로 먼저 뒤집고, 실패하면 되돌린다.
// 팔로우는 되돌리기 쉬운 동작이라 확인 절차를 두지 않는다. 대신 실패는 분명히 알린다.

export function FollowButton({
  researcherId,
  initialFollowing,
  signedIn,
}: {
  researcherId: string;
  initialFollowing: boolean;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [following, setFollowing] = useState(initialFollowing);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  const toggle = async () => {
    if (busy) return;
    if (!signedIn) {
      router.push(`/login?next=/r/${researcherId}`);
      return;
    }
    const next = !following;
    setFollowing(next); // 낙관적 반영 — 누른 즉시 바뀐다
    setError(null);
    setBusy(true);
    try {
      const res = await fetch(`/api/follows/${researcherId}`, {
        method: next ? "POST" : "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "처리하지 못했습니다");
      }
      // 팔로워 수는 서버가 세므로 새로고침해 실제 값을 받는다
      startTransition(() => router.refresh());
    } catch (e) {
      setFollowing(!next); // 되돌리기
      setError(e instanceof Error ? e.message : "처리하지 못했습니다");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        onClick={toggle}
        disabled={busy || pending}
        aria-pressed={following}
        className={`${styles.btn} ${following ? styles.on : ""}`}
      >
        {following ? "팔로잉" : "팔로우"}
      </button>
      {error && <span className={styles.error}>{error}</span>}
    </span>
  );
}
