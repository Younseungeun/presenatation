"use client";

import { useState } from "react";
import {
  ABUSE_CATEGORIES,
  ABUSE_CATEGORY_LABEL,
  type AbuseCategory,
} from "@/server/abuseReportService";
import styles from "../researcher/researcher.module.css";

// 신고 접수 폼 — POST /api/abuse-reports. 접수 후에는 완료 안내로 바뀐다.

export function CleanReportForm() {
  const [category, setCategory] = useState<AbuseCategory>("ONE_ON_ONE");
  const [targetName, setTargetName] = useState("");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <p className={styles.sub}>
        ✅ 신고가 접수되었습니다. 운영자 검토 후 결과를 알림으로 안내드립니다. 클린 리서치에
        함께해 주셔서 감사합니다.
      </p>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/abuse-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetName, category, detail }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "접수에 실패했습니다");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "접수에 실패했습니다");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={styles.form}>
      <label className={styles.label}>
        어떤 행위인가요?
        <select
          className={styles.input}
          value={category}
          onChange={(e) => setCategory(e.target.value as AbuseCategory)}
        >
          {ABUSE_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {ABUSE_CATEGORY_LABEL[c]}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.label}>
        대상 (리서처 필명 또는 리포트 제목)
        <input
          className={styles.input}
          value={targetName}
          onChange={(e) => setTargetName(e.target.value)}
          placeholder="예: 크립토애널리스트 / 비트코인 4분기 전망"
          required
          maxLength={200}
        />
      </label>

      <label className={styles.label}>
        정황·근거 (10자 이상)
        <textarea
          className={styles.input}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder="언제, 어디서(리포트 본문·댓글 등), 어떤 내용이 있었는지 적어 주세요. 캡처가 있다면 내용을 옮겨 적어 주세요."
          rows={5}
          required
          minLength={10}
          maxLength={4000}
        />
      </label>

      {error && <p className={styles.error}>{error}</p>}

      <button type="submit" className={styles.primaryBtn} disabled={busy}>
        {busy ? "접수 중…" : "신고 접수"}
      </button>
    </form>
  );
}
