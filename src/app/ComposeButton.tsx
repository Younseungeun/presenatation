"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  dismissFloating,
  isFloatingDismissed,
  serverDismissSnapshot,
  subscribeFloatingDismiss,
} from "./floatingDismiss";
import { floatingSlotFor } from "./floatingSlot";
import styles from "./composeButton.module.css";

/** 꾹 누르기로 판정하는 시간 — 짧으면 오작동, 길면 반응이 없다고 느낀다 */
const LONG_PRESS_MS = 500;
/** 이만큼 움직였으면 누르기가 아니라 스크롤·드래그다 */
const PRESS_SLOP = 8;

// 글쓰기 버튼 — 리서처에게만 보이는 동그란 떠 있는 버튼.
//
// **한 버튼이 화면마다 다른 일을 하지는 않는다.** 같은 자리·같은 모양이 홈에서는 무료 글,
// 리더보드에서는 유료 카드를 열면 "방금 뭘 눌렀지"가 된다. 특히 예측 카드는 게시 후
// 수정·삭제가 불가능하고 점수까지 걸리는 되돌릴 수 없는 행위라, 잘못 들어간 비용이 크다.
//
// 대신 **선택지의 순서**를 화면에 맞춘다. 홈에서 열면 무료 시황이 위에,
// 그 밖에서는 예측 카드가 위에 온다. 하는 일은 어디서나 같고 권하는 것만 달라진다.
// 무료 시황 활성화에도 이쪽이 유리하다 — 지금은 리서처 대시보드 안쪽에 있어 존재를
// 모르는데, 이 메뉴에서는 어느 화면에서 열든 늘 동등한 선택지로 보인다.

export function ComposeButton({
  researcherId,
  hasJudgment,
}: {
  researcherId: string;
  hasJudgment: boolean;
}) {
  const pathname = usePathname();
  // 어느 화면에서 열었는지를 담는다 — 화면을 옮기면 열림이 저절로 풀린다.
  // (effect로 닫으면 이동할 때마다 렌더가 한 번 더 돈다)
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;
  const setOpen = (next: boolean) => setOpenAt(next ? pathname : null);
  // 꾹 눌러 숨기기를 물었을 때 뜨는 확인 상자
  const [confirming, setConfirming] = useState(false);

  const dismissed = useSyncExternalStore(
    subscribeFloatingDismiss,
    () => isFloatingDismissed("compose"),
    serverDismissSnapshot,
  );
  // 검증 팝업이 닫히면 홈에서도 이 자리가 비므로 글쓰기 버튼이 물려받는다.
  // 같은 저장소를 구독하고 있어 닫는 즉시 함께 다시 그려진다
  const judgmentDismissed = useSyncExternalStore(
    subscribeFloatingDismiss,
    () => isFloatingDismissed("judgment"),
    serverDismissSnapshot,
  );

  const slot = floatingSlotFor(pathname, {
    hasJudgment: hasJudgment && !judgmentDismissed,
    canCompose: true,
  });
  const visible = slot === "compose" && !dismissed;

  useEffect(() => {
    if (!open && !confirming) return;
    const onKey = (e: KeyboardEvent) => {
      // setOpenAt을 직접 부른다 — setOpen은 매 렌더 새로 만들어지는 함수라
      // 의존성에 넣으면 리스너를 매번 다시 붙이게 된다
      if (e.key === "Escape") {
        setOpenAt(null);
        setConfirming(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, confirming]);

  // 꾹 누르기 — 손가락이 머무는 동안만 재고, 움직이거나 떼면 없던 일이 된다.
  // 타이머를 ref에 두는 이유: 취소는 렌더와 무관하게 즉시 일어나야 한다
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressPoint = useRef({ x: 0, y: 0 });
  const longPressed = useRef(false);

  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  useEffect(() => cancelPress, []);

  function onPointerDown(e: React.PointerEvent) {
    longPressed.current = false;
    pressPoint.current = { x: e.clientX, y: e.clientY };
    cancelPress();
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      setOpenAt(null);
      setConfirming(true);
    }, LONG_PRESS_MS);
  }
  function onPointerMove(e: React.PointerEvent) {
    const dx = e.clientX - pressPoint.current.x;
    const dy = e.clientY - pressPoint.current.y;
    if (Math.hypot(dx, dy) > PRESS_SLOP) cancelPress();
  }

  if (!visible) return null;

  // 홈에서는 무료 시황을 먼저 권한다 (홈이 무료 글을 읽는 자리이기도 하다)
  const freeFirst = pathname === "/";
  const items = [
    {
      key: "card",
      href: `/researcher/${researcherId}/new`,
      title: "예측 카드 리포트",
      sub: "판정·정산 대상 · 게시 후 수정 불가",
    },
    {
      key: "free",
      href: `/researcher/${researcherId}/free`,
      title: "무료 시황",
      sub: "예측 카드 없이 관점만 · 판정 대상 아님",
    },
  ];
  const ordered = freeFirst ? [items[1], items[0]] : items;

  return (
    <>
      {(open || confirming) && (
        <button
          type="button"
          className={styles.scrim}
          aria-label="닫기"
          onClick={() => {
            setOpen(false);
            setConfirming(false);
          }}
        />
      )}

      <div className={styles.wrap}>
        {/* 꾹 눌러 숨기기 — 확인을 한 단계 두는 이유는 되돌리는 법을 함께 알려야 하기 때문이다.
            버튼이 말없이 사라지면 "글쓰기가 없어졌다"가 되고, 복구 경로를 모르면 그게 진짜 문제다 */}
        {confirming && (
          <div className={styles.confirm} role="dialog" aria-label="글쓰기 버튼 숨기기">
            <span className={styles.confirmTitle}>글쓰기 버튼 숨기기</span>
            <span className={styles.confirmSub}>
              앱을 다시 열면 나타납니다. MY의 &lsquo;새 리포트&rsquo;로도 언제든 쓸 수 있어요.
            </span>
            <span className={styles.confirmRow}>
              <button
                type="button"
                className={styles.confirmCancel}
                onClick={() => setConfirming(false)}
              >
                취소
              </button>
              <button
                type="button"
                className={styles.confirmGo}
                onClick={() => {
                  setConfirming(false);
                  dismissFloating("compose");
                }}
              >
                숨기기
              </button>
            </span>
          </div>
        )}

        {open && (
          <div className={styles.menu} role="menu">
            {ordered.map((it) => (
              <Link
                key={it.key}
                href={it.href}
                className={styles.item}
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                <span className={styles.itemTitle}>{it.title}</span>
                <span className={styles.itemSub}>{it.sub}</span>
              </Link>
            ))}
          </div>
        )}

        <button
          type="button"
          className={`${styles.fab} ${open ? styles.fabOpen : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onPointerLeave={cancelPress}
          // 길게 누르면 브라우저 기본 메뉴가 뜨는 환경이 있어 막는다
          onContextMenu={(e) => e.preventDefault()}
          onClick={() => {
            // 꾹 누르기로 확인 상자를 띄운 뒤 손을 떼면 click도 따라오므로 그때는 무시한다
            if (longPressed.current) {
              longPressed.current = false;
              return;
            }
            setOpen(!open);
          }}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={open ? "글쓰기 메뉴 닫기" : "리포트 쓰기 (길게 누르면 숨기기)"}
        >
          {/* 열리면 같은 획이 X로 돌아간다 — 버튼이 사라지지 않고 상태만 바뀐다 */}
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 5v14M5 12h14"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </>
  );
}
