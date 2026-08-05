"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { JUDGMENT_POPUP_DISMISS_KEY } from "../ActiveJudgmentPopup";
import styles from "../researcher/researcher.module.css";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
    // 다음 사람이 로그인하면 그 사람의 검증 현황을 처음부터 알린다
    sessionStorage.removeItem(JUDGMENT_POPUP_DISMISS_KEY);
    router.push("/");
    router.refresh();
  }

  return (
    <button
      type="button"
      className={`${styles.actionBtn} ${styles.danger}`}
      onClick={logout}
      disabled={busy}
    >
      {busy ? "로그아웃 중…" : "로그아웃"}
    </button>
  );
}
