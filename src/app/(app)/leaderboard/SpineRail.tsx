"use client";

import { useEffect, useRef } from "react";
import styles from "./leaderboard.module.css";

// 카드 레일 + 스파인 — 가로 스크롤의 진행을 밑줄 한 획으로 보여준다.
//
// 겉상자를 걷어낸 팔로우 블록에서 "더 있다"를 알리는 장치가 없어지는데,
// 네이티브 스크롤바를 되살리면 OS마다 생김새가 다르고 두껍다. 대신 잉크 한 줄이
// 스크롤바 역할을 한다: 채워진 조각의 폭 = 보이는 비율, 위치 = 지금 어디쯤.
// 카드가 한 화면에 다 들어오면 줄 자체를 그리지 않는다 — 진행이 없는 곳의
// 진행 표시는 장식이다.
//
// 표시만 하는 게 아니라 **끌 수 있다** — 조각을 잡아 끌거나 궤도를 누르면
// 그 지점으로 레일이 간다 (진짜 스크롤바처럼). 드래그가 scrollLeft를 바꾸면
// scroll 이벤트가 돌아와 조각 위치를 갱신하므로 상태 동기화 경로는 하나뿐이다.
//
// 스크롤·드래그마다 setState를 하지 않는다 — ref로 직접 스타일을 만진다.
// (한 프레임에 수십 번 도는 이벤트라 리렌더 비용을 낼 이유가 없다)

export function SpineRail({ children }: { children: React.ReactNode }) {
  const railRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const rail = railRef.current;
    const track = trackRef.current;
    const thumb = thumbRef.current;
    if (!rail || !track || !thumb) return;

    const update = () => {
      const max = rail.scrollWidth - rail.clientWidth;
      if (max <= 1) {
        track.style.display = "none";
        return;
      }
      track.style.display = "";
      const ratio = rail.clientWidth / rail.scrollWidth;
      const pos = rail.scrollLeft / max;
      thumb.style.width = `${ratio * 100}%`;
      thumb.style.left = `${pos * (1 - ratio) * 100}%`;
    };

    update();
    rail.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(rail);
    return () => {
      rail.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  /** 궤도 위의 포인터 x → 레일 scrollLeft (조각 중심이 손가락을 따라온다) */
  function scrollToPointer(clientX: number) {
    const rail = railRef.current;
    const track = trackRef.current;
    if (!rail || !track) return;
    const max = rail.scrollWidth - rail.clientWidth;
    if (max <= 1) return;
    const rect = track.getBoundingClientRect();
    const thumbW = rect.width * (rail.clientWidth / rail.scrollWidth);
    const x = clientX - rect.left - thumbW / 2;
    const frac = Math.min(1, Math.max(0, x / (rect.width - thumbW)));
    rail.scrollLeft = frac * max;
  }

  return (
    <>
      <div ref={railRef} className={styles.prRail}>
        {children}
      </div>
      {/* 측정 전에는 그리지 않는다 — 스크롤이 없는 레일에 줄이 깜빡 보였다 사라지면 안 된다.
          포인터 전용 조작이라 aria는 숨긴다 — 키보드·터치 사용자는 레일 자체를 쓴다 */}
      <div
        ref={trackRef}
        className={styles.spineTrack}
        style={{ display: "none" }}
        aria-hidden="true"
        onPointerDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          try {
            trackRef.current?.setPointerCapture(e.pointerId);
          } catch {
            // 합성 이벤트 등 유효하지 않은 pointerId — 캡처 없이도 드래그는 동작한다
          }
          scrollToPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) scrollToPointer(e.clientX);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
        onPointerCancel={() => {
          draggingRef.current = false;
        }}
      >
        <div ref={thumbRef} className={styles.spineThumb} />
      </div>
    </>
  );
}
