"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher.module.css";

/**
 * 무료 시황 작성 — 예측 카드 입력이 없다.
 * 판정·정산 대상이 아니므로 게시 후에도 잠기지 않는다(유료 카드와 다른 점).
 */
export function FreeReportForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reports/free", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: String(form.get("title") ?? ""),
          summary: String(form.get("summary") ?? ""),
          content: String(form.get("content") ?? ""),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "게시 실패");
        return;
      }
      router.push(`/report/${body.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="title">
          제목
        </label>
        <input
          id="title"
          name="title"
          className={styles.input}
          maxLength={200}
          required
          placeholder="8월 첫째 주 코인 시황"
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="summary">
          요약
        </label>
        <input
          id="summary"
          name="summary"
          className={styles.input}
          maxLength={300}
          required
          placeholder="목록에 보이는 한 줄 소개"
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="content">
          본문
        </label>
        <textarea
          id="content"
          name="content"
          className={styles.textarea}
          style={{ minHeight: 260 }}
          required
          placeholder="공개 자료를 정리한 시황을 작성하세요."
        />
        <span className={styles.hint}>
          무료 글은 누구나 바로 읽을 수 있고, 예측 카드가 없어 판정·환불 대상이 아닙니다.
          특정 종목의 매수·매도를 권유하는 표현은 넣지 마세요.
        </span>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formActions}>
        <button type="submit" className={styles.primaryBtn} disabled={busy}>
          {busy ? "게시 중…" : "무료로 게시하기"}
        </button>
      </div>
    </form>
  );
}
