"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { usePlatformBiometric } from "@/lib/biometricSupport";
import { FingerprintIcon, PinIcon } from "../brand/Icons";
import { PinLogin } from "./PinLogin";
import s from "./simpleLogin.module.css";

// 간편 로그인 흐름 (2026-08-28 사용자 확정):
//   ① 생체 하드웨어 있음 → 생체 인증 먼저(지갑 결제 참고 — 중앙 링 + 계단식 등장)
//   ② 생체 없음          → 바로 간편 비밀번호
//   ③ 생체 3회 실패      → 방법 선택 화면(간편비밀번호 / 생체인증 + 다른 방식)
//
// 웹 WebAuthn 은 브라우저 정책상 사용자 제스처가 있어야 뜨는 경우가 많아, "생체 먼저"는
// = 진입 시 자동 시도하되 막히면 링을 탭해 진행(자동 + 탭 폴백). 자동 시도의 실패는
// 3회 카운트에 넣지 않는다(제스처 문제일 수 있다) — 탭한 시도만 센다.

const BIO_FAIL_LIMIT = 3;

const NO_SUBSCRIBE = () => () => {};
const useHasDevice = () =>
  useSyncExternalStore(
    NO_SUBSCRIBE,
    () => document.cookie.split("; ").some((c) => c.startsWith("rm_device_hint=")),
    () => false,
  );

type Mode = "init" | "bio" | "pin" | "picker";

export function SimpleLogin() {
  const hasDevice = useHasDevice();
  const bio = usePlatformBiometric(); // true | false | null(아직 모름)
  const [mode, setMode] = useState<Mode>("init");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const failsRef = useRef(0);
  const autoTried = useRef(false);

  // **개발 전용 ?demo=bio|pin|picker** (운영 빌드에선 무시) — 생체 화면은 생체 하드웨어 +
  // 보안 컨텍스트가 있어야만 진짜로 뜬다(LAN http 폰에선 PublicKeyCredential 자체가 꺼진다).
  // 실제 /login 페이지에서 각 상태를 눈으로 확인하려는 용도라 쿠키(간편로그인 설정)가
  // 없어도 렌더한다. 마운트 후 set 이라 하이드레이션이 어긋나지 않는다. 진짜 인증은 그대로 시도.
  const [demoMode, setDemoMode] = useState<Exclude<Mode, "init"> | null>(null);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    const d = new URLSearchParams(window.location.search).get("demo");
    if (d === "bio" || d === "pin" || d === "picker") setDemoMode(d);
  }, []);

  // 초기 갈래 결정 — 생체 없으면 PIN, 있으면(또는 아직 모름은 대기 후) 생체
  useEffect(() => {
    if (mode !== "init") return;
    if (demoMode) {
      setMode(demoMode);
      return;
    }
    if (!hasDevice) return;
    if (bio === false) setMode("pin");
    else if (bio === true) setMode("bio");
    // bio === null → 아직 모름, 다음 렌더를 기다린다
  }, [hasDevice, bio, mode, demoMode]);

  async function attemptBio(isAuto: boolean) {
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
      // 자동 시도의 실패는 제스처 문제일 수 있어 세지 않는다 — 탭한 시도만 센다
      if (!isAuto) {
        failsRef.current += 1;
        if (failsRef.current >= BIO_FAIL_LIMIT) {
          setMode("picker");
          setBusy(false);
          return;
        }
      }
      const name = (e as { name?: string })?.name;
      const cancelled = name === "NotAllowedError" || name === "AbortError";
      setError(
        cancelled
          ? "인증이 취소됐어요. 링을 눌러 다시 시도하세요."
          : "생체 인증이 되지 않았어요. 다시 시도하거나 아래에서 방법을 바꾸세요.",
      );
    } finally {
      setBusy(false);
    }
  }

  // 생체 화면에 들어오면 한 번 자동 시도
  useEffect(() => {
    if (mode === "bio" && !autoTried.current) {
      autoTried.current = true;
      void attemptBio(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  if (!hasDevice && !demoMode) return null; // 간편 로그인이 설정된 기기에서만(데모는 예외)

  if (mode === "pin") return <PinLogin />;

  if (mode === "picker") {
    return (
      <MethodPicker
        busy={busy}
        onPin={() => setMode("pin")}
        onBio={() => {
          failsRef.current = 0;
          setError(null);
          void attemptBio(false);
          setMode("bio");
        }}
        onFullAuth={() => {
          document.getElementById("fullauth")?.scrollIntoView({ behavior: "smooth" });
        }}
      />
    );
  }

  if (mode === "bio") {
    return (
      <BioPrompt
        busy={busy}
        error={error}
        onTap={() => void attemptBio(false)}
        onUsePin={() => setMode("pin")}
      />
    );
  }

  return null; // init — 곧 위 effect가 갈래를 정한다
}

// ── 표시: 생체 인증 링 ──────────────────────────────────────
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

// 얼굴 스캔 글리프 — 뷰파인더 네 모서리 브래킷 + 단순한 얼굴(눈·미소). 참고 영상의
// 얼굴 인증 형태를 우리 획·민트로 옮긴 것(특정 제품 아이콘의 좌표 복제가 아니다).
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
      {/* 네 모서리 브래킷 */}
      <path d="M6 16v-6a4 4 0 0 1 4-4h6" />
      <path d="M32 6h6a4 4 0 0 1 4 4v6" />
      <path d="M42 32v6a4 4 0 0 1-4 4h-6" />
      <path d="M16 42h-6a4 4 0 0 1-4-4v-6" />
      {/* 눈 */}
      <path d="M18 20v3.5" />
      <path d="M30 20v3.5" />
      {/* 미소 */}
      <path d="M18.5 30q5.5 4.5 11 0" />
    </svg>
  );
}

// 인증 성공 글리프 — 동그라미 속 체크(참고 영상). 톡 튀어나오며 체크가 그려진다.
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

// 인증 글리프(모핑) — 인증 전 4모서리(사각 뷰파인더) + 얼굴, 성공하면 모서리가
// 회전·수축하며 사라지고 원이 감싸며 나타나 체크를 그린다(참고 영상). done 토글로 앞뒤 재생.
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
        {/* 그려지는 동안 쓰는 민트 계열 다색 그라데이션 (완료되면 솔리드 민트로 덮인다) */}
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
        {/* 그려지는 동안 = 민트 계열 다색 그라데이션 */}
        <circle
          cx="24"
          cy="24"
          r="19"
          strokeWidth={2.6}
          stroke={`url(#${gid})`}
          className={`${s.ringCircle} ${done ? s.ringCircleDone : ""}`}
        />
        {/* 다 채워지면 = 현재 색(민트)으로 정착 */}
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
      {/* 완료 순간 퍼지는 민트 고리 */}
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

// ── 표시: 방법 선택 (두 카드 + 로그인 + 다른 방식) ──────────
export function MethodPicker({
  busy,
  onPin,
  onBio,
  onFullAuth,
}: {
  busy: boolean;
  onPin: () => void;
  onBio: () => void;
  onFullAuth: () => void;
}) {
  const [choice, setChoice] = useState<"bio" | "pin">("bio");
  return (
    <div className={`${s.wrap} ${s.rise}`}>
      <h2 className={s.pickerTitle}>로그인 방법 선택</h2>
      <div className={s.grid}>
        <button
          type="button"
          className={`${s.card} ${choice === "pin" ? s.cardOn : ""}`}
          onClick={() => setChoice("pin")}
          aria-pressed={choice === "pin"}
        >
          <span className={s.cardIcon}>
            <PinIcon />
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
            <FingerprintIcon />
          </span>
          <span className={s.cardLabel}>생체 인증</span>
        </button>
      </div>
      <button
        type="button"
        className={s.primary}
        disabled={busy}
        onClick={() => (choice === "bio" ? onBio() : onPin())}
      >
        {busy ? "…" : "로그인"}
      </button>
      <button type="button" className={s.alt} onClick={onFullAuth}>
        다른 방식으로 로그인 &gt;
      </button>
    </div>
  );
}
