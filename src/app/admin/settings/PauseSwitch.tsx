"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./adminSettings.module.css";

// 자동 판정 정지 스위치.
//
// **다른 스위치와 다르게 사유를 묻는다.** 나머지 설정은 "보여줄지 말지"라 되돌리기가
// 쉽지만, 이건 멈춘 동안 판정이 밀리고 밀린 판정은 이월 상한(14일)에 닿으면 전액
// 환불로 끝난다. 왜 멈췄는지 모르면 **언제 풀어야 하는지도 모른다.**
//
// **정지는 화면에 두고 롤백은 CLI에 둔다.** 성격이 반대이기 때문이다 —
// 정지는 보호적이라 남이 눌러도 손해가 "판정이 늦어짐"이고 사고 때 가장 빨리 눌러야
// 하는 것이지만, 일괄 롤백은 파괴적이라 세션 하나가 하루치 판정을 날릴 수 있다.
// TOTP가 붙기 전까지 파괴적 행위는 셸 접근을 요구하는 자리에 둔다.
export function PauseSwitch({
  scope,
  label,
  initial,
}: {
  scope: string;
  label: string;
  initial: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    const next = !on;
    const reason = window.prompt(
      next
        ? `${label} 자동 판정을 멈춥니다. 사유를 적어주세요 (감사 로그에 남습니다)`
        : `${label} 자동 판정을 다시 엽니다. 시세가 정상인지 확인하셨나요? 사유를 적어주세요`,
    );
    if (!reason || reason.trim().length < 2) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/judgment-pause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, paused: next, reason: reason.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "저장하지 못했습니다");
      setOn(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>
          {label} {on && <strong>— 정지 중</strong>}
        </div>
        <p className={styles.rowDesc}>
          {on
            ? "판정·도달 판정 배치가 이 범위를 건드리지 않습니다. 시세를 직접 확인한 뒤 여세요 — 자동 해제는 없습니다."
            : "정상 동작 중입니다."}
        </p>
        {error && <p className={styles.rowError}>{error}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={`${label} 자동 판정 정지`}
        className={`${styles.switch} ${on ? styles.switchOn : ""}`}
        onClick={toggle}
        disabled={busy}
      >
        <span className={styles.knob} />
      </button>
    </div>
  );
}
