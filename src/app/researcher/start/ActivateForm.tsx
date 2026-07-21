"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../researcher.module.css";

// 리서처 전환: 이용계약 동의 후 프로필 생성. 동의 없으면 진행 불가.
export function ActivateForm() {
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function activate() {
    if (!agreed) {
      setError("리서처 이용계약에 동의해야 시작할 수 있습니다.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/researcher/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreedResearcher: true }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "전환 실패");
        return;
      }
      router.push(`/researcher/${body.researcherId}`);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.form}>
      <label className={styles.consent}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          <Link href="/terms/RESEARCHER_AGREEMENT" target="_blank">
            리서처 이용계약
          </Link>
          에 동의하며, 유사투자자문업 신고 등 관련 법령상 의무를 스스로 확인·이행하겠습니다 (필수)
        </span>
      </label>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.formActions}>
        <button className={styles.primaryBtn} onClick={activate} disabled={busy || !agreed}>
          {busy ? "전환 중…" : "리서처로 활동 시작"}
        </button>
      </div>
    </div>
  );
}
