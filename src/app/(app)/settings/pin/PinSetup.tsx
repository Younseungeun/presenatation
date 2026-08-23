"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { startRegistration } from "@simplewebauthn/browser";
import { usePlatformBiometric } from "@/lib/biometricSupport";
import styles from "./pin.module.css";

// 간편 비밀번호 설정 — **가입 직후 반드시 거치는 화면** (2026-08-16 사용자 확정).
//
// 순서가 구조를 말한다:
//   ① 간편 비밀번호 (필수)  — 모든 기기의 폴백
//   ② 생체 등록 (선택 동의) — 동의하면 다음부터 생체가 우선이 된다
// 비밀번호를 먼저 받는 이유: 생체는 안 되는 기기·안 되는 순간(장갑, 마스크, 센서
// 오류)이 있어 폴백 없이는 못 세운다. 생체만 있고 비밀번호가 없으면 그 순간 풀
// 로그인으로 떨어져 "간편"이 사라진다.

export function PinSetup() {
  const router = useRouter();
  const next = useSearchParams().get("next") ?? "/";
  // 지문 장치가 **확실히 없을 때만** 이 단계를 건너뛴다. 아직 모르는 상태(null)에서
  // 건너뛰면, 지문이 되는 기기의 사용자에게 물어보지도 않고 지나가게 된다
  const biometricSupported = usePlatformBiometric() !== false;

  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [step, setStep] = useState<"PIN" | "BIOMETRIC">("PIN");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitPin() {
    if (pin !== pin2) {
      setError("두 번 입력한 번호가 다릅니다");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pin/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "설정에 실패했습니다");
      // 비밀번호가 섰으니, 생체를 지원하는 기기면 동의를 물어본다
      if (biometricSupported) setStep("BIOMETRIC");
      else router.push(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "설정에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function enrollBiometric() {
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
        body: JSON.stringify({ response, label: "내 기기" }),
      });
      if (!res.ok) throw new Error((await res.json())?.error ?? "등록에 실패했습니다");
      router.push(next);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      // 지문 창을 닫은 것은 "지금은 안 할래"다 — 동의 안 한 것으로 두고 넘어간다
      if (name === "NotAllowedError" || name === "AbortError") {
        router.push(next);
        return;
      }
      setError(e instanceof Error ? e.message : "등록에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (step === "BIOMETRIC") {
    return (
      <div className={styles.box}>
        <h2 className={styles.title}>지문·얼굴로 더 빠르게 (선택)</h2>
        <p className={styles.body}>
          동의하시면 다음부터 <strong>생체 인식이 우선</strong>이 되고, 간편 비밀번호는
          생체가 안 될 때만 씁니다. 지문·얼굴은 기기 밖으로 나가지 않습니다 — 저희가 받는
          것은 기기가 만든 서명뿐입니다.
        </p>
        <button type="button" className={styles.primary} onClick={enrollBiometric} disabled={busy}>
          {busy ? "등록하는 중…" : "생체 인식 사용하기"}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => router.push(next)}
          disabled={busy}
        >
          비밀번호만 쓸게요
        </button>
        {error && <p className={styles.error}>{error}</p>}
      </div>
    );
  }

  return (
    <div className={styles.box}>
      <h2 className={styles.title}>간편 비밀번호 만들기</h2>
      <p className={styles.body}>
        다음부터 이 기기에서는 <strong>숫자 6자리</strong>로 로그인합니다. 이 비밀번호는
        이 기기에서만 쓸 수 있어, 다른 곳에서 입력해도 열리지 않습니다.
      </p>
      <label className={styles.field}>
        비밀번호 (숫자 6자리)
        <input
          className={styles.input}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          type="password"
          autoComplete="off"
        />
      </label>
      <label className={styles.field}>
        한 번 더
        <input
          className={styles.input}
          value={pin2}
          onChange={(e) => setPin2(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          type="password"
          autoComplete="off"
        />
      </label>
      <button
        type="button"
        className={styles.primary}
        onClick={submitPin}
        disabled={busy || pin.length !== 6 || pin2.length !== 6}
      >
        {busy ? "설정하는 중…" : "설정하기"}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
