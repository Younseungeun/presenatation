"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import styles from "../researcher/researcher.module.css";

// 관리자 부트스트랩 관문 (2026-08-17 검토 6차 Q1) — **패스키 등록 전에는 아무것도 못 한다.**
//
// 관리자 권한이 신원(본인 인증)에 걸려 있어서, 패스키가 0개인 공백기에 유심을 가로챈
// 공격자가 들어오면 그가 심는 패스키가 "첫 기기"가 되어 48시간 유예 없이 계정을
// 장악한다. 그래서 이 화면이 다른 모든 관리 화면을 가리고, 서버 API도 같은 조건으로
// 닫혀 있다(requireOperatorId) — 화면만 가리면 API를 직접 부르면 그만이니까.

export function OperatorPasskeyGate() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch("/api/passkey/register");
      const optionsJSON = await optionsRes.json();
      if (!optionsRes.ok) {
        // 최근성 관문(REVERIFY_REQUIRED)에 걸렸다면 — 간편 로그인으로 들어온 세션이다.
        // 등록은 방금 본인 인증한 세션만 할 수 있으니 풀 로그인으로 보낸다
        throw new Error(
          optionsJSON?.error ??
            "등록을 시작할 수 없습니다 — 본인 인증으로 다시 로그인한 직후에 등록해주세요.",
        );
      }
      const response = await startRegistration({ optionsJSON });
      const res = await fetch("/api/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, label: "관리자 기기" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "등록에 실패했습니다");
      // 관문이 열렸다 — 전체 로드로 서버가 새 상태를 읽게 한다
      window.location.reload();
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "AbortError") {
        setBusy(false);
        return;
      }
      setError(e instanceof Error ? e.message : "등록에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <div className={styles.card} style={{ marginTop: 24 }}>
        <div className={styles.cardTop}>
          <div className={styles.cardTitle}>관리자 권한 활성화</div>
        </div>
        <p className={styles.sub}>
          관리자 기능을 쓰려면 <strong>이 기기의 지문·얼굴(패스키)을 먼저 등록</strong>해야
          합니다. 등록 전에는 어떤 관리 기능도 열리지 않습니다 — 계정을 훔친 사람이
          첫 열쇠를 심는 것을 막는 관문이라서, 건너뛸 수 없습니다.
        </p>
        <p className={styles.sub}>
          등록은 <strong>본인 인증으로 로그인한 직후 10분 안</strong>에만 됩니다.
          시간이 지났다면 로그아웃 후 본인 인증으로 다시 들어와 주세요.
        </p>
        <div className={styles.formActions}>
          <button className={styles.primaryBtn} onClick={register} disabled={busy}>
            {busy ? "등록 중…" : "이 기기에 지문·얼굴 등록"}
          </button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    </main>
  );
}
