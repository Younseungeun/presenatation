"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import styles from "./activeJudgmentPopup.module.css";

// 진행 중인 판정 팝업 — 홈의 '내 검증 현황' 섹션을 대신한다.
// 섹션은 MY와 중복이라 지면만 차지했으므로, 기존 '가장 가까운 판정' 박스(민트 스트립)를
// 그대로 살려 하단 탭바 위에 띄우고 누르면 MY의 검증 중 목록으로 바로 넘긴다.
//
// 닫기는 X 버튼 대신 **왼쪽으로 밀기**: 살짝 밀면 '지우기'가 드러나고, 많이 밀면 바로 사라진다
// (목록에서 항목을 미는 흔한 조작 관행). 닫힘은 이 방문에만 유지 —
// 다음 진입에 다시 알려야 하는 정보라 저장하지 않는다.

/** 밀린 카드와 '지우기' 박스 사이 간격(px) */
const GAP = 10;
/**
 * 밀기 판정은 팝업 폭에 대한 비율로 한다 (화면 크기와 무관하게 같은 감각).
 * 카드는 손가락 위치 변화만큼 그대로 따라가고, 손을 뗀 순간 아래 세 갈래로 갈린다:
 *  · 12.5% 미만 → 원래 자리로
 *  · 12.5% 이상 25% 미만 → 25% 위치로 자동 이동 (빈 공간에 '지우기' 박스)
 *  · 25% 이상 → 묻지 않고 바로 삭제
 */
const OPEN_RATIO = 0.125;
const DELETE_RATIO = 0.25;
/** 폭을 아직 재지 못했을 때 쓰는 기본값 */
const FALLBACK_WIDTH = 320;
/** 이 거리 이상 움직였으면 탭이 아니라 스와이프 — 링크 이동을 막는다 */
const DRAG_SLOP = 6;
/**
 * 닫힘 기억 — 이번 방문에만 유지한다 (앱을 다시 열면 검증 현황을 새로 알린다).
 * 로그인할 때도 지워서 새로 들어온 사람에게는 다시 알린다 (login/LoginForm에서 호출).
 */
export const JUDGMENT_POPUP_DISMISS_KEY = "rm.judgmentPopup.dismissed.v1";
const DISMISS_KEY = JUDGMENT_POPUP_DISMISS_KEY;

export function ActiveJudgmentPopup({
  activeCount,
  nearestTitle,
  dday,
}: {
  activeCount: number;
  nearestTitle: string | null;
  dday: string | null;
}) {
  const pathname = usePathname();
  const onMyScreen = pathname.startsWith("/my");
  // 서버 HTML과 어긋나지 않게 첫 렌더는 감춘 상태로 두고, 마운트 후 닫힘 여부를 읽는다
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // 손을 뗀 뒤의 고정 위치만 상태로 둔다 — 미는 동안에는 DOM을 직접 움직여야 부드럽다
  const [offset, setOffset] = useState(0);

  // 이 컴포넌트는 레이아웃에 있어 화면을 옮겨도 살아 있고, 앱을 새로 실행할 때만 다시 붙는다.
  // 그래서 "처음 붙는 순간 = 앱 실행"으로 보고 닫았던 기록을 지운다 (실행할 때마다 다시 알림).
  const freshLaunch = useRef(true);
  // sessionStorage는 서버에 없어 렌더 중에는 읽을 수 없다(하이드레이션 불일치).
  // 마운트 후 한 번 읽어 상태를 맞추는 것이 이 값의 유일한 동기화 경로다 —
  // set-state-in-effect 규칙이 겨냥하는 연쇄 렌더가 아니라 외부 저장소 구독에 해당한다.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (freshLaunch.current) {
      freshLaunch.current = false;
      sessionStorage.removeItem(DISMISS_KEY);
    }
    if (onMyScreen) {
      // MY로 갔으면 목적을 다한 팝업이다 — 이번 실행에서는 다시 띄우지 않는다
      sessionStorage.setItem(DISMISS_KEY, "1");
      setDismissed(true);
    } else {
      // 로그인·로그아웃이 기록을 지웠다면 다시 뜬다
      setDismissed(sessionStorage.getItem(DISMISS_KEY) !== null);
    }
    setReady(true);
  }, [pathname, onMyScreen]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const close = () => {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };
  const startX = useRef(0);
  const moved = useRef(0);
  // 상태 갱신은 다음 렌더에 반영되므로, 판단은 항상 ref로 한다
  // (한 프레임 안에 down→move가 몰려도 밀림이 끊기지 않는다)
  const draggingRef = useRef(false);
  const offsetRef = useRef(0);
  // 밀기 무대의 폭 — 12.5%·25% 기준선을 계산하는 바탕
  const swipeRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLAnchorElement>(null);
  const boxRef = useRef<HTMLButtonElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const stageWidth = useRef(0);
  const armedRef = useRef(false);
  // 박스 안에서 시작한 밀기는 손가락이 박스를 벗어나도 계속 따라가야 한다.
  // 요소에 붙인 리스너는 포인터가 요소를 떠나면 (캡처가 안 먹는 환경에서) 끊기므로,
  // 미는 동안에는 window에 리스너를 붙였다가 손을 떼면 거둔다.
  const activePointerId = useRef<number | null>(null);
  const windowListeners = useRef<{
    move: (e: PointerEvent) => void;
    up: (e: PointerEvent) => void;
  } | null>(null);
  const detachWindowListeners = () => {
    const l = windowListeners.current;
    if (!l) return;
    window.removeEventListener("pointermove", l.move);
    window.removeEventListener("pointerup", l.up);
    window.removeEventListener("pointercancel", l.up);
    windowListeners.current = null;
  };
  // 미는 도중 화면을 떠나는 경우(내비게이션 등)에도 리스너를 남기지 않는다
  useEffect(() => detachWindowListeners, []);

  // 폭은 미리 재둔다 — 키보드로 열 때처럼 손가락 없이 여는 경우에도 기준이 필요하다
  useEffect(() => {
    const measure = () => {
      stageWidth.current = swipeRef.current?.getBoundingClientRect().width ?? 0;
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [ready, dismissed, onMyScreen]);

  if (!ready || dismissed || onMyScreen || activeCount === 0) return null;

  const stage = () => stageWidth.current || FALLBACK_WIDTH;
  /** 열린 상태로 고정되는 거리 (팝업 폭의 25%) */
  const openDistance = () => stage() * DELETE_RATIO;
  const boxWidthOf = (dragged: number) => Math.max(0, dragged - GAP);
  /** 25%를 넘겼다 — 놓기만 해도 삭제된다 */
  const isArmed = (dragged: number) => dragged >= stage() * DELETE_RATIO;

  /**
   * 미는 동안 화면 갱신 — 리렌더 없이 DOM만 직접 움직여야 손가락을 따라온다.
   * resting은 손을 뗀 뒤 안착한 상태 — 이때는 "놓으면 삭제"가 아니라 평범한 '지우기'다.
   */
  const paint = (next: number, resting = false) => {
    offsetRef.current = next;
    const dragged = -next;
    if (cardRef.current) cardRef.current.style.transform = `translateX(${next}px)`;
    if (boxRef.current) boxRef.current.style.width = `${boxWidthOf(dragged)}px`;
    const armed = !resting && isArmed(dragged);
    if (armed !== armedRef.current) {
      armedRef.current = armed;
      boxRef.current?.classList.toggle(styles.armed, armed);
      if (labelRef.current) labelRef.current.textContent = armed ? "놓으면 삭제" : "지우기";
    }
    if (labelRef.current) {
      labelRef.current.style.opacity = boxWidthOf(dragged) >= 52 ? "1" : "0";
    }
  };

  /**
   * 손을 뗀 뒤의 고정 위치 — DOM에도 바로 쓴다.
   * (상태 값이 이전과 같으면 React가 리렌더를 건너뛰어, 미는 동안 직접 쓴 위치가 남는다)
   * 전환 클래스가 벗겨진 상태라 CSS 전환으로 부드럽게 안착한다.
   */
  const slide = (next: number) => {
    paint(next, true);
    setOffset(next);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (draggingRef.current) return; // 두 번째 손가락은 무시 — 첫 손가락만 따라간다
    activePointerId.current = e.pointerId;
    startX.current = e.clientX - offsetRef.current; // 열려 있던 상태에서 이어서 밀 수 있게
    moved.current = 0;
    stageWidth.current = swipeRef.current?.getBoundingClientRect().width ?? 0;
    draggingRef.current = true;
    // 전환을 즉시 끈다 (상태 갱신을 기다리면 한 박자 늦어 손가락을 따라오지 못한다)
    cardRef.current?.classList.add(styles.dragging);
    boxRef.current?.classList.add(styles.dragging);
    // 시작만 박스 안이면 이후에는 화면 어디서 움직여도 좌우 이동량만큼 따라간다
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerId.current || !draggingRef.current) return;
      const dx = ev.clientX - startX.current;
      moved.current = Math.max(moved.current, Math.abs(dx - offsetRef.current));
      // 손가락 위치 변화만큼 그대로 따라간다 (왼쪽으로만, 무대 폭까지)
      paint(dx > 0 ? 0 : Math.max(dx, -stage()));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== activePointerId.current) return;
      settle();
    };
    windowListeners.current = { move, up };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const settle = () => {
    detachWindowListeners();
    activePointerId.current = null;
    if (!draggingRef.current) return;
    draggingRef.current = false;
    cardRef.current?.classList.remove(styles.dragging);
    boxRef.current?.classList.remove(styles.dragging);
    const dragged = -offsetRef.current;
    // 움직임 없는 탭은 삭제로 보지 않는다 (열린 상태에서 카드를 눌렀을 때 대비)
    if (moved.current > DRAG_SLOP && isArmed(dragged)) {
      close(); // 25%를 넘겼으면 묻지 않고 바로 삭제
    } else if (dragged >= stage() * OPEN_RATIO) {
      slide(-openDistance()); // 12.5%를 넘겼으면 25% 위치로 자동 이동
    } else {
      slide(0); // 12.5%에 못 미치면 원래 자리로
    }
  };

  /** 손을 뗀 상태의 값 — 미는 동안에는 paint()가 DOM을 직접 갱신한다 */
  const boxWidth = boxWidthOf(-offset);
  const opened = offset < 0;

  return (
    <div className={styles.wrap} role="status">
      <div className={styles.swipe} ref={swipeRef}>
        {/* 밀린 만큼 생긴 빈 공간을 그대로 채운다 — 많이 밀수록 커진다 */}
        <button
          ref={boxRef}
          type="button"
          className={styles.delete}
          style={{ width: boxWidth }}
          onClick={close}
          // 키보드 사용자는 밀 수 없으므로 포커스가 오면 버튼을 드러낸다
          onFocus={() => slide(-openDistance())}
          tabIndex={0}
        >
          <span
            ref={labelRef}
            className={styles.deleteLabel}
            style={{ opacity: boxWidth >= 52 ? 1 : 0 }}
          >
            지우기
          </span>
        </button>
        <Link
          ref={cardRef}
          href="/my?mode=buyer&tab=active"
          className={styles.card}
          style={{ transform: `translateX(${offset}px)` }}
          onPointerDown={onPointerDown}
          onClick={(e) => {
            // 스와이프 중이거나 '지우기'가 열려 있으면 이동하지 않는다 (열린 건 닫는다)
            if (moved.current > DRAG_SLOP || opened) {
              e.preventDefault();
              if (opened && moved.current <= DRAG_SLOP) slide(0);
            }
          }}
        >
          <span className={styles.copy}>
            <strong className={styles.title}>검증 중인 예측 {activeCount}건</strong>
            {nearestTitle && (
              <span className={styles.sub}>가장 가까운 판정 · {nearestTitle}</span>
            )}
          </span>
          {dday && <span className={styles.dday}>{dday}</span>}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M9 6l6 6-6 6"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
      </div>
    </div>
  );
}
