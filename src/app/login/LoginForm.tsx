"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { JUDGMENT_POPUP_DISMISS_KEY } from "../ActiveJudgmentPopup";
import styles from "../researcher/researcher.module.css";

/**
 * 본인 인증 폼 (스텁). 실서비스에서는 PASS/NICE 본인확인 창으로 대체된다.
 * 같은 휴대폰 번호는 항상 같은 계정으로 매핑된다 (1인 1계정).
 */
export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") ?? "/";
  const [busy, setBusy] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!agreed) {
      setError("이용약관·개인정보처리방침에 동의해야 시작할 수 있습니다.");
      return;
    }
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: f.get("name"),
          phone: f.get("phone"),
          penName: f.get("penName") || undefined,
          agreedTerms: agreed,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "인증 실패");
        return;
      }
      // 새로 로그인했으면 검증 현황을 다시 알린다 (이전 방문에서 닫았더라도)
      sessionStorage.removeItem(JUDGMENT_POPUP_DISMISS_KEY);
      router.push(next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label className={styles.label}>이름</label>
        <input className={styles.input} name="name" required placeholder="홍길동" />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>휴대폰 번호</label>
        <input
          className={styles.input}
          name="phone"
          required
          inputMode="numeric"
          placeholder="010-1234-5678"
        />
        <span className={styles.hint}>같은 번호는 항상 같은 계정으로 연결됩니다 (1인 1계정).</span>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>필명 (선택)</label>
        <input className={styles.input} name="penName" placeholder="공개 활동명" maxLength={30} />
        <span className={styles.hint}>실명 대신 표시될 이름입니다. 나중에 설정할 수도 있어요.</span>
      </div>

      <label className={styles.consent}>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        <span>
          <Link href="/terms/TERMS_OF_SERVICE" target="_blank">
            이용약관
          </Link>
          {" 및 "}
          <Link href="/terms/PRIVACY_POLICY" target="_blank">
            개인정보처리방침
          </Link>
          에 동의합니다 (필수)
        </span>
      </label>

      {error && (
        <div className={styles.error}>{error}</div>
      )}

      <div className={styles.formActions}>
        <button className={styles.primaryBtn} type="submit" disabled={busy || !agreed}>
          {busy ? "인증 중…" : "본인 인증하고 시작"}
        </button>
      </div>
    </form>
  );
}
