"use client";

import { useRef, useState } from "react";
import type { PayoutAccountView } from "@/server/payoutAccountView";
import { OtpInput, type OtpInputHandle, type OtpStatus } from "../../OtpInput";
import styles from "./payout.module.css";

// 유예 즉시 해제 — **번호는 낯선 기기에, 입력은 평소 기기에** (2026-08-16 사용자 확정).
//
// 같은 화면이 기기에 따라 두 얼굴을 가진다:
//   낯선 기기(변경을 만든 기기)  → 확인 번호를 크게 보여준다. 입력란은 없다
//   평소 기기                    → 입력란을 보여준다. 번호는 없다
// 한 기기에 둘 다 보여주면 "두 기기를 오가며 확인한다"는 절차가 셀프 승인으로 무너진다.
//
// 입력 화면의 사기 경고가 이 장치의 마지막 방어다 — 기술 관문을 전부 통과하는 유일한
// 우회로가 "전화로 번호 입력을 시키는 것"(보이스피싱)이라, 그 문장으로만 막힌다.
//
// ⚠ **이 화면은 기능 검증용 최소 형태다** (2026-08-17 사용자 확정 — 디자인 보류).
// 번호 표시의 시각 디자인, 알림→입력 화면 진입 동선, 두 기기를 오가는 안내는
// 디자인 작업 때 다시 정한다. 그때도 지켜야 하는 불변은 둘이다:
//   ① 한 기기에 번호와 입력란을 같이 보여주지 않는다 (셀프 승인이 된다)
//   ② 사기 경고 문구를 지우지 않는다 (보이스피싱이 유일한 우회로다)

export function CooldownConfirm({
  view,
  onDone,
}: {
  view: PayoutAccountView;
  onDone: (v: PayoutAccountView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<OtpStatus>("idle");
  const field = useRef<OtpInputHandle>(null);

  // ── 낯선 기기: 번호를 보여주는 쪽 ──────────────────────────
  if (view.cooldownCode != null) {
    return (
      <div className={styles.notice}>
        <strong>지금 바로 지급되게 하려면</strong> — 평소 쓰시는 기기(지문·얼굴이나 간편
        비밀번호로 로그인하는 기기)에서 이 화면을 열고, 아래 확인 번호를 입력하세요.
        입력하지 않아도 {view.cooldownHoursLeft}시간 뒤에는 지급됩니다.
        <div
          style={{
            fontSize: "1.9rem",
            fontWeight: 800,
            letterSpacing: "0.35em",
            textAlign: "center",
            padding: "10px 0 4px",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {view.cooldownCode}
        </div>
      </div>
    );
  }

  // ── 평소 기기: 입력을 받는 쪽 ──────────────────────────────
  // 6자리를 다 채우면 자동으로 확인한다(OTP 관례). 틀리면 흔들림 + 초기화 후 다시 입력.
  async function submit(value: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/payout/account/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: value.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "확인에 실패했습니다");
        setStatus("error");
        field.current?.clear();
        return;
      }
      setStatus("success");
      onDone(json);
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
      field.current?.clear();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.notice}>
      <strong>본인이 새 기기에서 계좌를 바꾸신 게 맞나요?</strong> 새 기기 화면에 표시된
      확인 번호를 입력하면 {view.cooldownHoursLeft}시간 대기 없이 바로 지급됩니다.
      <div style={{ padding: "10px 0 2px" }}>
        <OtpInput
          ref={field}
          status={status}
          disabled={busy}
          autoFocus
          ariaLabel="유예 해제 확인 번호"
          onChange={() => {
            // 오류 뒤 다시 입력을 시작하면 흔들림·빨강을 걷는다
            if (status !== "idle") {
              setStatus("idle");
              setError(null);
            }
          }}
          onComplete={submit}
        />
        {busy && (
          <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-faint,#8b95a1)" }}>
            확인 중…
          </p>
        )}
      </div>
      {/* 이 문장이 이 장치의 마지막 방어다 — 지우면 보이스피싱이 유일한 우회로가 된다 */}
      <p style={{ margin: "6px 0 0", fontWeight: 700 }}>
        전화·문자로 이 번호 입력을 요구받으셨다면 입력하지 마세요 — 그건 사기입니다.
        이 번호는 본인이 직접 새 기기 화면에서 보고 옮겨 적는 용도입니다.
      </p>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
