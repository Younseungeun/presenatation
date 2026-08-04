"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../researcher/researcher.module.css";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" });
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
