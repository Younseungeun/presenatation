"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./adminSettings.module.css";

// 운영 설정 스위치 한 개. 저장은 즉시 — 확인 버튼을 따로 두면 껐다고 생각하고 나가는 사고가 난다.
export function SettingToggle({
  settingKey,
  title,
  description,
  initial,
  disabled,
}: {
  settingKey: string;
  title: string;
  description: string;
  initial: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !on;
    setBusy(true);
    setError(null);
    // 눌린 즉시 반영하고 실패하면 되돌린다 — 스위치는 반응이 늦으면 두 번 눌리게 된다
    setOn(next);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: settingKey, value: next }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "저장하지 못했습니다");
      router.refresh();
    } catch (err) {
      setOn(!next);
      setError(err instanceof Error ? err.message : "저장하지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`${styles.row} ${disabled ? styles.rowDim : ""}`}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>{title}</div>
        <p className={styles.rowDesc}>{description}</p>
        {error && <p className={styles.rowError}>{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={title}
        className={`${styles.switch} ${on ? styles.switchOn : ""}`}
        onClick={toggle}
        disabled={busy || disabled}
      >
        <span className={styles.knob} />
      </button>
    </div>
  );
}
