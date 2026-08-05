"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher/researcher.module.css";

/** 필명 수정. 저장하면 표시 이름이 바로 바뀐다 (리서처는 공개 프로필에도 반영) */
export function ProfileForm({
  initialPenName,
  researcherId,
}: {
  initialPenName: string;
  researcherId: string | null;
}) {
  const router = useRouter();
  const [penName, setPenName] = useState(initialPenName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/me/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ penName: penName.trim() || null }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "저장하지 못했습니다");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label className={styles.label}>필명</label>
        <input
          className={styles.input}
          value={penName}
          onChange={(e) => {
            setPenName(e.target.value);
            setSaved(false);
          }}
          maxLength={30}
          placeholder="공개 활동명"
        />
        <span className={styles.hint}>최대 30자. 비우면 익명으로 표시됩니다.</span>
      </div>

      {error && <div className={styles.error}>{error}</div>}
      {saved && <div className={styles.hint}>저장했습니다.</div>}

      <div className={styles.formActions}>
        <button className={styles.primaryBtn} type="submit" disabled={busy}>
          {busy ? "저장 중…" : "저장"}
        </button>
        {researcherId && (
          <Link className={styles.actionBtn} href={`/r/${researcherId}`}>
            공개 프로필 보기
          </Link>
        )}
      </div>
    </form>
  );
}
