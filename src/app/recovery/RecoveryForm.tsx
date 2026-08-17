"use client";

import { useState } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import styles from "../researcher/researcher.module.css";

// 두 단계짜리 화면이다:
//   ① 금고에서 꺼낸 종이로 서명한 표를 붙여 넣는다  → 서버가 확인하고 등록만 열어 준다
//   ② 이 기기에 지문·얼굴을 등록한다                → 여기서부터는 평소 경로로 돌아간다
//
// 두 단계를 한 버튼으로 묶지 않는다. ①이 성공했는지 ②가 실패했는지 구분이 안 되면,
// 정작 필요한 날 무엇이 잘못됐는지 알 수 없다.

type Stage = "TOKEN" | "PASSKEY" | "DONE";

export function RecoveryForm() {
  const [stage, setStage] = useState<Stage>("TOKEN");
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function redeem() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim(), note: note.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "복구에 실패했습니다");
      setStage("PASSKEY");
    } catch (e) {
      setError(e instanceof Error ? e.message : "복구에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch("/api/passkey/register");
      const optionsJSON = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(optionsJSON?.error ?? "등록을 시작할 수 없습니다");
      const response = await startRegistration({ optionsJSON });
      const res = await fetch("/api/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, label: "비상 복구 기기" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "등록에 실패했습니다");
      setStage("DONE");
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
      <div className={styles.card} style={{ marginTop: 24, maxWidth: 640 }}>
        <div className={styles.cardTop}>
          <div className={styles.cardTitle}>비상 복구</div>
        </div>

        {stage === "TOKEN" && (
          <>
            <p className={styles.sub}>
              본인 인증이 불가능하고 등록된 기기도 모두 잃었을 때만 쓰는 경로입니다.
              <strong> 금고 속 종이 열쇠로 서명한 복구 표</strong>를 붙여 넣어주세요.
            </p>
            <p className={styles.sub}>
              통과해도 열리는 것은 <strong>이 기기에 지문·얼굴을 등록하는 것 하나</strong>
              뿐입니다. 그리고 복구 뒤 <strong>48시간 동안은 돈을 내보내는 기능이 멈춥니다</strong> —
              금고를 연 사람이 본인이 아닐 수 있고, 그 사실을 알아챌 시간이 필요하기 때문입니다.
              (돈을 <strong>막는</strong> 조작인 정산 동결은 그동안에도 됩니다.)
            </p>
            <label className={styles.field}>
              <span className={styles.label}>복구 표</span>
              <textarea
                className={styles.textarea}
                rows={4}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="IVREC1.…"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>사유 (기록에 남습니다)</span>
              <input
                className={styles.input}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="예: 본인 인증 공급자 장애 + 기기 분실"
              />
            </label>
            <div className={styles.formActions}>
              <button
                className={styles.primaryBtn}
                onClick={redeem}
                disabled={busy || !token.trim()}
              >
                {busy ? "확인 중…" : "복구 표 확인"}
              </button>
            </div>
          </>
        )}

        {stage === "PASSKEY" && (
          <>
            <p className={styles.sub}>
              복구 표가 확인되었습니다. 이제 <strong>이 기기의 지문·얼굴을 등록</strong>하면
              평소 로그인으로 돌아갑니다.
            </p>
            <p className={styles.sub}>
              쓴 표는 다시 쓸 수 없습니다 — 등록에 실패하면 금고의 종이로 새로 서명해주세요.
            </p>
            <div className={styles.formActions}>
              <button className={styles.primaryBtn} onClick={register} disabled={busy}>
                {busy ? "등록 중…" : "이 기기에 지문·얼굴 등록"}
              </button>
            </div>
          </>
        )}

        {stage === "DONE" && (
          <>
            <p className={styles.sub}>
              등록이 끝났습니다. 로그인 화면에서 <strong>지문·얼굴로 로그인</strong>해주세요.
            </p>
            <p className={styles.sub}>
              공급자 장애가 끝나면 <strong>예비 기기의 패스키를 다시 만들어 두세요</strong> —
              이 경로를 두 번 쓰지 않는 것이 목표입니다.
            </p>
            <div className={styles.formActions}>
              <a className={styles.primaryBtn} href="/login">
                로그인으로
              </a>
            </div>
          </>
        )}

        {error && <p className={styles.error}>{error}</p>}
      </div>
    </main>
  );
}
