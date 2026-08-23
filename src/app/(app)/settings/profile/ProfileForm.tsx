"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BIO_MAX_LENGTH } from "@/domain/researcherBio";
import styles from "../../researcher/researcher.module.css";

/**
 * 필명·소개말 수정. 저장하면 표시 이름이 바로 바뀐다.
 * 소개말은 리서처만 — 팔로우당하지 않는 계정에는 PR 자리가 없다.
 */
export function ProfileForm({
  initialPenName,
  initialBio,
  researcherId,
}: {
  initialPenName: string;
  initialBio: string;
  researcherId: string | null;
}) {
  const router = useRouter();
  const [penName, setPenName] = useState(initialPenName);
  const [bio, setBio] = useState(initialBio);
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
        body: JSON.stringify({
          penName: penName.trim() || null,
          ...(researcherId ? { bio: bio.trim() || null } : {}),
        }),
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

      {researcherId && (
        <div className={styles.field}>
          <label className={styles.label}>소개말</label>
          <textarea
            className={styles.input}
            value={bio}
            onChange={(e) => {
              setBio(e.target.value);
              setSaved(false);
            }}
            maxLength={BIO_MAX_LENGTH}
            rows={2}
            placeholder="예: 반도체·2차전지를 주로 봅니다"
          />
          <span className={styles.hint}>
            {bio.length}/{BIO_MAX_LENGTH}자. 팔로워의 리더보드와 공개 프로필에 표시됩니다.
            수익률 수치·수익 약속·외부 연락처는 쓸 수 없습니다.
          </span>
        </div>
      )}

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
