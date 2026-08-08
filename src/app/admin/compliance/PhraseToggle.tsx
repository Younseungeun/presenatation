"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../researcher/researcher.module.css";

// 학습 표현 활성/비활성. 삭제하지 않는 이유: 같은 위반이 다시 확인되면 되살려야 하고,
// 어떤 표현이 왜 꺼졌는지가 사전의 이력 자체이기 때문.

export function PhraseToggle({ phraseId, active }: { phraseId: string; active: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SET_PHRASE_ACTIVE", phraseId, active: !active }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.formActions}>
      <button className={styles.actionBtn} onClick={toggle} disabled={busy}>
        {busy ? "처리 중…" : active ? "비활성화 (작성 화면에서 숨김)" : "다시 활성화"}
      </button>
    </div>
  );
}
