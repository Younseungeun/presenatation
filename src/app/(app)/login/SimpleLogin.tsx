"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { usePlatformBiometric } from "@/lib/biometricSupport";
import { GlassButton } from "../GlassButton";
import { IntovillMark } from "../brand/Logo";
import { PinLogin } from "./PinLogin";
import s from "./simpleLogin.module.css";

// 간편 로그인 흐름 (2026-08-29 사용자 확정 — 방식 선택이 곧 진입 화면):
//   · 생체 하드웨어 있음 → **방식 선택**(간편비밀번호 / 생체 인증) 카드가 로그인 화면이다.
//     '생체 인증 + 로그인'을 누르면 **이 화면 위에서 기기 OS(WebAuthn) 시트가 바로** 뜬다 —
//     우리가 만드는 스캔 화면은 없다. 실제 스캔 연출은 iOS/안드로이드 것.
//   · 생체 없음 → 바로 간편 비밀번호.
//   · '다른 방식으로 로그인'은 이 화면에서 뺐다(2026-08-29). 새 기기는 본인 인증이
//     유일한 길이라 LoginScreen 이 그 경우 본인 인증을 바로 보여준다.

const NO_SUBSCRIBE = () => () => {};
const useHasDevice = () =>
  useSyncExternalStore(
    NO_SUBSCRIBE,
    () => document.cookie.split("; ").some((c) => c.startsWith("rm_device_hint=")),
    () => false,
  );

type Mode = "init" | "picker" | "pin";

export function SimpleLogin() {
  const hasDevice = useHasDevice();
  const bio = usePlatformBiometric(); // true | false | null(아직 모름)
  const [mode, setMode] = useState<Mode>("init");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // **개발 전용 ?demo=picker|pin** (운영 빌드에선 무시) — 등록 기기·생체가 없어도 화면을
  // 눈으로 확인하려는 용도. 마운트 후 set 이라 하이드레이션이 어긋나지 않는다.
  const [demoMode, setDemoMode] = useState<Exclude<Mode, "init"> | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const d = new URLSearchParams(window.location.search).get("demo");
    if (d === "picker" || d === "bio") setDemoMode("picker"); // 'bio'는 옛 이름 → picker
    else if (d === "pin") setDemoMode("pin");
  }, []);

  // 초기 갈래 — 생체 있으면 방식 선택(picker), 없으면 바로 간편 비밀번호(pin).
  useEffect(() => {
    if (mode !== "init") return;
    if (demoMode) {
      setMode(demoMode);
      return;
    }
    if (!hasDevice) return;
    if (bio === false) setMode("pin");
    else if (bio === true) setMode("picker");
    // bio === null → 아직 모름, 다음 렌더를 기다린다
  }, [hasDevice, bio, mode, demoMode]);

  // 생체 인증 — 이 화면 위에서 바로 기기 OS(WebAuthn) 시트를 띄운다. 성공하면 이동,
  // 실패하면 화면에 사유만 남기고 방식 선택에 머문다(간편 비밀번호로 바꿀 수 있다).
  async function attemptBio() {
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch("/api/passkey/login");
      if (!optionsRes.ok) throw new Error("options");
      const response = await startAuthentication({ optionsJSON: await optionsRes.json() });
      const verifyRes = await fetch("/api/passkey/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!verifyRes.ok) throw new Error("verify");
      const v = await verifyRes.json();
      window.location.href = v.operator ? "/admin" : "/";
      return;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      const cancelled = name === "NotAllowedError" || name === "AbortError";
      setError(
        cancelled
          ? "인증이 취소됐어요. 다시 시도해 주세요."
          : "생체 인증이 되지 않았어요. 다시 시도하거나 간편 비밀번호로 로그인하세요.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!hasDevice && !demoMode) return null; // 간편 로그인이 설정된 기기에서만(데모는 예외)

  if (mode === "pin") return <PinLogin />;

  if (mode === "picker") {
    return (
      <MethodPicker
        busy={busy}
        error={error}
        onPin={() => setMode("pin")}
        onBio={() => void attemptBio()}
        onFullAuth={() => {
          // 비밀번호 재설정 = 휴대폰 본인 인증 → 인증 직후 간편 비밀번호 재설정 화면으로.
          // reset=1 이면 등록 기기여도 LoginScreen 이 본인 인증 폼을 재설정 모드로 띄운다
          // (가입 UI 없이 휴대폰 인증만). 통신사 인증(PASS/NICE) 실공급자가 붙는 자리다.
          window.location.href = "/login?reset=1&next=" + encodeURIComponent("/settings/pin");
        }}
      />
    );
  }

  return null; // init — 곧 위 effect가 갈래를 정한다
}

// ── 표시: 방법 선택 (두 카드 + 로그인). 우리 브랜드(잉크 선택·자체 아이콘·자체 문구). ──
// '다른 방식'(onFullAuth)은 넘겨줄 때만 그린다 — 간편 로그인 화면에선 넘기지 않아 안 뜬다.
export function MethodPicker({
  busy,
  onPin,
  onBio,
  onFullAuth,
  error,
}: {
  busy: boolean;
  onPin: () => void;
  onBio: () => void;
  onFullAuth?: () => void;
  error?: string | null;
}) {
  const [choice, setChoice] = useState<"bio" | "pin">("bio");
  return (
    <div className={`${s.wrap} ${s.rise}`}>
      <h2 className={s.brandHead}>
        <IntovillMark size={33} />
        <span className={s.brandSub}>간편 로그인</span>
      </h2>
      <div className={s.grid}>
        <button
          type="button"
          className={`${s.card} ${choice === "pin" ? s.cardOn : ""}`}
          onClick={() => setChoice("pin")}
          aria-pressed={choice === "pin"}
        >
          <span className={s.cardIcon}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={s.pinImg} src="/login/pin.png" alt="" width={70} height={70} />
          </span>
          <span className={s.cardLabel}>간편 비밀번호</span>
        </button>
        <button
          type="button"
          className={`${s.card} ${choice === "bio" ? s.cardOn : ""}`}
          onClick={() => setChoice("bio")}
          aria-pressed={choice === "bio"}
        >
          <span className={s.cardIcon}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={s.bioImg} src="/login/bioscan.png" alt="" width={70} height={70} />
          </span>
          <span className={s.cardLabel}>생체 인증</span>
        </button>
      </div>
      <GlassButton
        type="button"
        size="lg"
        tone="mint"
        disabled={busy}
        onClick={() => (choice === "bio" ? onBio() : onPin())}
        style={{ width: "100%", marginTop: 16 }}
      >
        {busy ? "인증하는 중…" : "로그인"}
      </GlassButton>
      {error && <p className={s.err}>{error}</p>}
      {/* 복구 경로 — 간편 비밀번호를 잊으면 휴대폰 본인 인증으로 재설정한다(생체도 막힌
          경우의 유일한 탈출구). 주인공이 아니라 복구라 가운데 조용한 링크로 둔다. */}
      {onFullAuth && (
        <button type="button" className={s.recoverLink} onClick={onFullAuth}>
          비밀번호 재설정 &gt;
        </button>
      )}
    </div>
  );
}

// ── 아래 글리프들은 데모(flow-demo)·미리보기에서 쓴다 (실제 로그인에선 OS가 스캔을 그린다) ──

// 표시: 생체 인증 링 (얼굴 스캔 글리프)
export function BioPrompt({
  busy,
  error,
  onTap,
  onUsePin,
}: {
  busy: boolean;
  error: string | null;
  onTap: () => void;
  onUsePin: () => void;
}) {
  return (
    <div className={`${s.wrap} ${s.rise}`}>
      <div className={s.bio}>
        <button
          type="button"
          className={`${s.faceScan} ${busy ? "" : s.faceScanIdle}`}
          onClick={onTap}
          disabled={busy}
          aria-label="얼굴·지문으로 로그인"
        >
          <FaceScanGlyph />
          {busy && <span className={s.scanLine} />}
        </button>
        <span className={s.bioText}>{busy ? "인증하는 중…" : "얼굴·지문으로 로그인"}</span>
        <span className={`${s.bioSub} ${error ? s.bioErr : ""}`}>
          {error ?? "기기에 등록한 지문이나 얼굴로 바로 들어갑니다."}
        </span>
        <button type="button" className={s.textLink} onClick={onUsePin}>
          간편 비밀번호로 로그인
        </button>
      </div>
    </div>
  );
}

// 얼굴 스캔 글리프 — 뷰파인더 네 모서리 브래킷 + 단순한 얼굴(눈·미소).
export function FaceScanGlyph() {
  return (
    <svg
      viewBox="0 0 48 48"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 16v-6a4 4 0 0 1 4-4h6" />
      <path d="M32 6h6a4 4 0 0 1 4 4v6" />
      <path d="M42 32v6a4 4 0 0 1-4 4h-6" />
      <path d="M16 42h-6a4 4 0 0 1-4-4v-6" />
      <path d="M18 20v3.5" />
      <path d="M30 20v3.5" />
      <path d="M18.5 30q5.5 4.5 11 0" />
    </svg>
  );
}

// 인증 성공 글리프 — 동그라미 속 체크. 톡 튀어나오며 체크가 그려진다.
export function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 48 48"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={s.checkPop}
    >
      <circle cx="24" cy="24" r="19" />
      <path d="M15 24.5l6.2 6.2L33 17.5" className={s.checkMark} />
    </svg>
  );
}

// 인증 글리프(모핑) — 4모서리(사각 뷰파인더)가 회전·수축하며 사라지고 원이 둘레를
// 그리며 감싸 체크를 그린다(민트 다색 그라데이션 채움 → 솔리드 정착). done 토글로 앞뒤 재생.
export function AuthGlyph({ done }: { done: boolean }) {
  const gid = "agrad" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg
      viewBox="0 0 48 48"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ overflow: "visible" }}
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1" gradientTransform="rotate(20 24 24)">
          <stop offset="0%" stopColor="#9FEBD6" />
          <stop offset="26%" stopColor="#2ED3AC" />
          <stop offset="52%" stopColor="#0B7A66" />
          <stop offset="78%" stopColor="#12B896" />
          <stop offset="100%" stopColor="#7FE3CE" />
        </linearGradient>
      </defs>
      <g className={`${s.corners} ${done ? s.cornersDone : ""}`}>
        <path d="M6 16v-6a4 4 0 0 1 4-4h6" />
        <path d="M32 6h6a4 4 0 0 1 4 4v6" />
        <path d="M42 32v6a4 4 0 0 1-4 4h-6" />
        <path d="M16 42h-6a4 4 0 0 1-4-4v-6" />
        <path d="M18 20v3.5" />
        <path d="M30 20v3.5" />
        <path d="M18.5 30q5.5 4.5 11 0" />
      </g>
      <g className={`${s.ring} ${done ? s.ringDone : ""}`}>
        <circle
          cx="24"
          cy="24"
          r="19"
          strokeWidth={2.6}
          stroke={`url(#${gid})`}
          className={`${s.ringCircle} ${done ? s.ringCircleDone : ""}`}
        />
        <circle
          cx="24"
          cy="24"
          r="19"
          strokeWidth={2.6}
          className={`${s.ringSolid} ${done ? s.ringSolidDone : ""}`}
        />
        <path
          d="M15 24.5l6.2 6.2L33 17.5"
          strokeWidth={2.6}
          className={`${s.check} ${done ? s.checkDone : ""}`}
        />
      </g>
      <circle
        cx="24"
        cy="24"
        r="19"
        strokeWidth={1.8}
        className={`${s.ringFlash} ${done ? s.ringFlashDone : ""}`}
      />
    </svg>
  );
}
