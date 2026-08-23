"use client";

import { useState, useSyncExternalStore } from "react";
import styles from "./passkey.module.css";

// 간편 비밀번호 로그인 — **생체의 폴백** (2026-08-16 사용자 확정 순서).
//
// 이 기기에 간편 로그인이 설정돼 있을 때만 그린다. 판단 근거는 힌트 쿠키
// (rm_device_hint — 비밀이 아닌 "있다"는 사실만). 진짜 토큰은 httpOnly라 JS가
// 못 읽고, 서버가 요청에서 직접 확인한다.

const NO_SUBSCRIBE = () => () => {};
const useHasDevice = () =>
  useSyncExternalStore(
    NO_SUBSCRIBE,
    () => document.cookie.split("; ").some((c) => c.startsWith("rm_device_hint=")),
    () => false,
  );

export function PinLogin() {
  const hasDevice = useHasDevice();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);

  if (!hasDevice) return null;

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json();
      if (!res.ok) {
        // 잠긴 것은 다시 시도할 일이 아니다 — 풀 로그인으로 가는 길만 남긴다
        if (body?.code === "PIN_LOCKED" || body?.code === "UNKNOWN_DEVICE") setLocked(true);
        throw new Error(body?.error ?? "로그인에 실패했습니다");
      }
      // 관리자는 이용자 홈이 아니라 운영 대시보드가 첫 화면이다
      window.location.href = body.operator ? "/admin" : "/";
    } catch (e) {
      setError(e instanceof Error ? e.message : "로그인에 실패했습니다");
      setPin("");
    } finally {
      setBusy(false);
    }
  }

  if (locked) {
    return (
      <div className={styles.pinWrap}>
        <p className={styles.error}>{error}</p>
        <p className={styles.pinHint}>아래에서 본인 인증으로 로그인하면 다시 설정할 수 있습니다.</p>
      </div>
    );
  }

  return (
    <div className={styles.pinWrap}>
      <div className={styles.pinRow}>
        <input
          className={styles.pinInput}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && pin.length === 6 && !busy) signIn();
          }}
          inputMode="numeric"
          type="password"
          autoComplete="off"
          placeholder="간편 비밀번호 6자리"
          aria-label="간편 비밀번호"
        />
        <button
          type="button"
          className={styles.pinButton}
          onClick={signIn}
          disabled={busy || pin.length !== 6}
        >
          {busy ? "…" : "확인"}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
