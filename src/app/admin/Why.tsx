"use client";

import { createContext, useContext, useId, useState } from "react";
import a from "./admin.module.css";

// **설명은 접어 둔다** (시안).
//
// 매일 보는 화면에서 "왜 그런가"는 처음 몇 번만 필요하다. 늘 펼쳐 두면 매일 같은
// 문단을 지나쳐야 하고, 지나치는 습관이 붙으면 정작 **지금 사실**을 말하는 줄
// (한도 초과·되돌릴 수 없음)까지 함께 지나친다. 가른 기준은 길이가 아니라 성격이다:
//
//   · 왜 그런가        → 물음표 뒤로 접는다 (이 파일)
//   · 지금 무엇이 사실인가 → 그대로 남긴다  (.note / .gate / .sent — 접지 않는다)
//
// 지우지 않고 접는 이유: 이 문단들이 곧 이 화면의 설계 근거고, 한 달 뒤에
// "왜 이렇게 했지"를 묻는 사람이 나 자신이다.

const Ctx = createContext<{ open: boolean; toggle: () => void; id: string } | null>(null);

/** 물음표와 접힌 본문을 한 묶음으로 — 둘이 상태를 나눠 가진다 */
export function WhyGroup({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Ctx.Provider value={{ open, toggle: () => setOpen((v) => !v), id }}>{children}</Ctx.Provider>
  );
}

export function WhyToggle() {
  const ctx = useContext(Ctx);
  if (!ctx) return null;
  return (
    <button
      type="button"
      className={`${a.why} ${ctx.open ? a.whyOn : ""}`}
      aria-label="설명 보기"
      aria-expanded={ctx.open}
      aria-controls={ctx.id}
      onClick={ctx.toggle}
    >
      ?
    </button>
  );
}

export function WhyBody({
  children,
  className,
}: {
  children: React.ReactNode;
  /** 자리마다 옷이 다르다 — 묶음 머리는 .sechDesc, 카드 안은 .note */
  className?: string;
}) {
  const ctx = useContext(Ctx);
  if (!ctx || !ctx.open) return null;
  return (
    <div id={ctx.id} className={className ?? a.sechDesc}>
      {children}
    </div>
  );
}

/**
 * 묶음 머리 — 제목·건수는 늘 보이고 **설명만 접힌다.**
 * 설명이 없는 묶음은 물음표를 그리지 않는다(눌러도 아무 일 없는 단추는 고장으로 읽힌다).
 */
export function SecHead({
  title,
  children,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  if (!children) {
    return (
      <div className={a.sech}>
        <div className={a.sechTitle}>{title}</div>
      </div>
    );
  }
  return (
    <WhyGroup>
      <div className={a.sech}>
        <div className={a.sechTitle}>
          {title}
          <WhyToggle />
        </div>
        <WhyBody>{children}</WhyBody>
      </div>
    </WhyGroup>
  );
}

/**
 * 갈래 이름 — 두 갈래의 라벨(위반이 맞다면 / 아니라면)에도 같은 물음표가 붙는다.
 * `sub`는 접히지 않는다: 그것은 설명이 아니라 **무엇을 고르는 칸인지**의 이름이다.
 */
export function WhyLabel({
  children,
  sub,
  why,
}: {
  children: React.ReactNode;
  sub?: React.ReactNode;
  why?: React.ReactNode;
}) {
  if (!why) {
    return (
      <div className={a.lbl}>
        {children}
        {sub && <small>{sub}</small>}
      </div>
    );
  }
  return (
    <WhyGroup>
      <div className={a.lbl}>
        {children}
        {sub && <small>{sub}</small>}
        <WhyToggle />
      </div>
      {/* 갈래 안의 설명은 묶음 머리보다 얇게 — 상자를 두르면 갈래가 카드처럼 보인다 */}
      <WhyBody className={a.hint}>{why}</WhyBody>
    </WhyGroup>
  );
}
