"use client";

import { useEffect, useRef, useState } from "react";
import { IntovillAppIcon, IntovillLockup } from "./brand/Logo";
import styles from "./launch.module.css";

// 앱 실행 경험: 로고 스플래시(매 실행) → 온보딩.
// 온보딩 완료 여부는 기기 로컬에 저장한다(계정 무관, 로그인 전에도 보여줘야 하므로).
const ONBOARDED_KEY = "rm.onboarded.v1";
const SPLASH_MS = 900;

// 시제품 개발 단계: 매 실행마다 온보딩을 노출한다(문구·구성 확인 목적).
// 출시 시 false로 바꾸면 "첫 실행 1회"로 돌아간다 — 저장·건너뛰기 로직은 그대로 유지된다.
const ALWAYS_SHOW_ONBOARDING = true;

// 인앱 브라우저·시크릿 모드에서는 localStorage 접근 자체가 예외를 던진다.
// 저장이 막힌 환경에서는 온보딩을 건너뛴다(매번 띄워 발목 잡는 것보다 낫다).
function readOnboarded(): boolean | null {
  try {
    return localStorage.getItem(ONBOARDED_KEY) !== null;
  } catch {
    return null;
  }
}

function writeOnboarded() {
  try {
    localStorage.setItem(ONBOARDED_KEY, new Date().toISOString());
  } catch {
    /* 저장 불가 환경 — 무시 */
  }
}

// note = 각주. 본문만큼 중요하지는 않지만 그 자리에서 짚어두지 않으면
// 나중에 오해가 되는 것들을 담는다.
const SLIDES: { title: string; text: string; note?: string; art: React.ReactNode }[] = [
  {
    title: "예측 카드가 붙은 리포트",
    text: "모든 유료 리포트에는 종목·방향·목표 크기·검증 시한이 명시된 예측 카드가 함께 붙습니다.",
    // 카드 배경의 궤적을 "그 종목의 실제 차트"로 읽는 오해를 처음 만나는 자리에서 끊는다
    note: "카드 배경의 그래프는 예측의 방향·크기·기간을 요약한 그림이며, 실제 종목의 시세 차트가 아닙니다.",
    art: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <rect
          x="8"
          y="12"
          width="48"
          height="40"
          rx="8"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
        />
        <path
          d="M18 40l9-10 7 6 12-14"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M40 22h6v6"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "시한이 오면 시장이 채점",
    text: "검증 시한이 지나면 실제 시세 데이터로 적중·실패가 자동 판정됩니다. 사람이 점수를 매기지 않습니다.",
    art: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <circle cx="32" cy="32" r="22" stroke="var(--brand-strong)" strokeWidth="3.5" />
        <path
          d="M32 19v13l9 6"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    ),
  },
  {
    title: "틀리면 현금으로 환불",
    text: "결제액은 판정 전까지 에스크로에 보관됩니다. 예측이 틀리면 성과 연동분을 현금으로 돌려받습니다.",
    art: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path
          d="M50 30a18 18 0 1 1-6-13"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <path
          d="M45 10v8h-8"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M25 28h14M25 36h14M29 22l3 20M35 22l-3 20"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
  {
    title: "쌓인 판정이 곧 실력",
    text: "팔로워 수가 아니라 판정 기록이 점수와 등급을 만듭니다. 리더보드에서 검증된 리서처를 먼저 확인하세요.",
    art: (
      <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true">
        <path
          d="M14 50V36M32 50V22M50 50V28"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
        <path
          d="M10 14h44"
          stroke="var(--brand-strong)"
          strokeWidth="3.5"
          strokeLinecap="round"
          opacity="0.35"
        />
      </svg>
    ),
  },
];

export function AppLaunch() {
  const [phase, setPhase] = useState<"splash" | "fading" | "onboarding" | "done">("splash");
  const [index, setIndex] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);

  // 스플래시 → 온보딩 → 앱
  // ?tour=1 을 붙이거나 시제품 플래그가 켜져 있으면 이미 본 뒤에도 다시 노출한다.
  useEffect(() => {
    let forced = false;
    let deepLink = false;
    try {
      forced = new URLSearchParams(window.location.search).has("tour");
      // **깊은 주소로 바로 들어온 사람에게는 실행 경험이 끼어들지 않는다.**
      //
      // 스플래시와 온보딩은 "앱을 여는" 행위에 붙는 것이지 "이 리포트를 보는" 행위에
      // 붙는 것이 아니다. 알림·공유 링크·관리자의 "이용자가 보는 화면 그대로 열기"는
      // 전부 목적지가 정해진 방문이라, 그 앞에 로고 0.9초와 안내 4장을 세우면
      // **온 이유를 막고 서 있는 것**이 된다. 관리자 화면에서는 특히 나쁘다 —
      // 리포트를 확인하려고 누른 것인데 매번 튜토리얼이 뜬다.
      //
      // 홈은 그대로다. 처음 온 사람은 홈에서 만나고, `?tour=1`·설정의 "다시 보기"는
      // 어디서든 여전히 강제로 띄운다(위의 `forced`가 이 판단보다 먼저다).
      deepLink = window.location.pathname !== "/";
    } catch {
      /* 무시 */
    }
    const onboarded = readOnboarded();
    // 저장이 막힌 환경(onboarded === null)에서도 시제품 단계에는 노출한다
    const firstRun = forced || (!deepLink && (ALWAYS_SHOW_ONBOARDING || onboarded === false));

    // 딥링크는 스플래시도 건너뛴다 — 목적지가 있는 방문에 0.9초를 세울 이유가 없다
    if (deepLink && !forced) {
      setPhase("done");
      return;
    }

    const fadeAt = window.setTimeout(() => setPhase("fading"), SPLASH_MS);
    const doneAt = window.setTimeout(
      () => setPhase(firstRun ? "onboarding" : "done"),
      SPLASH_MS + 320,
    );
    return () => {
      window.clearTimeout(fadeAt);
      window.clearTimeout(doneAt);
    };
  }, []);

  // 온보딩 중에는 뒤쪽 앱이 스크롤되지 않도록 잠근다
  useEffect(() => {
    if (phase !== "onboarding") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [phase]);

  function finish() {
    writeOnboarded();
    setPhase("done");
  }

  // 스크롤은 CSS scroll-behavior가 부드럽게 처리한다.
  function goTo(next: number) {
    setIndex(next);
    const track = trackRef.current;
    if (!track) return;
    const from = track.scrollLeft;
    const target = track.clientWidth * next;
    track.scrollLeft = target;
    // 부드러운 스크롤 애니메이션이 아예 시작되지 않는 환경에서는 즉시 이동시킨다
    window.setTimeout(() => {
      if (track.scrollLeft !== from || from === target) return;
      const prev = track.style.scrollBehavior;
      track.style.scrollBehavior = "auto";
      track.scrollLeft = target;
      track.style.scrollBehavior = prev;
    }, 260);
  }

  const isLast = index === SLIDES.length - 1;

  return (
    <>
      {(phase === "splash" || phase === "fading") && (
        <div
          className={`${styles.splash} ${phase === "fading" ? styles.splashHiding : ""}`}
          aria-hidden="true"
        >
          <IntovillAppIcon size={96} className={styles.splashLogo} />
          {/* 락업 최소 폭 155px(README §5) — height 24 미만은 쓰지 않는다 */}
          <IntovillLockup height={30} className={styles.splashName} />
        </div>
      )}

      {phase === "onboarding" && (
        <div className={styles.onboarding} role="dialog" aria-modal="true" aria-label="앱 사용 안내">
          <div className={styles.skipRow}>
            <button type="button" className={styles.skip} onClick={finish}>
              건너뛰기
            </button>
          </div>

          <div
            className={styles.track}
            ref={trackRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              const next = Math.round(el.scrollLeft / el.clientWidth);
              if (next !== index) setIndex(next);
            }}
          >
            {SLIDES.map((s, i) => (
              <section key={s.title} className={styles.slide}>
                <div className={styles.art}>{s.art}</div>
                <span className={styles.step}>
                  {i + 1} / {SLIDES.length}
                </span>
                <h2 className={styles.slideTitle}>{s.title}</h2>
                <p className={styles.slideText}>{s.text}</p>
                {s.note && <p className={styles.slideNote}>{s.note}</p>}
              </section>
            ))}
          </div>

          <div className={styles.footer}>
            <div className={styles.dots}>
              {SLIDES.map((s, i) => (
                <span
                  key={s.title}
                  className={`${styles.dot} ${i === index ? styles.dotActive : ""}`}
                />
              ))}
            </div>
            <button
              type="button"
              className={styles.cta}
              onClick={() => (isLast ? finish() : goTo(index + 1))}
            >
              {isLast ? "시작하기" : "다음"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
