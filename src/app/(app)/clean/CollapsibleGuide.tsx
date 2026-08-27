"use client";

import { useState } from "react";
import g from "./cleanGuide.module.css";

// 신고 대상·보상 안내 — 접이식 (2026-08-27 창업자 지시 2번).
//
// **리포트에서 신고 버튼으로 들어온 사람은 뭘 신고할지 이미 알고 왔다.** 그런데 안내
// 두 덩어리(신고 대상 4종 + 보상 절차)가 폼을 아래로 밀어내, 본문 선택에 닿으려면
// 다 지나야 했다. 그래서 리포트 진입(defaultOpen=false)이면 안내를 접어 폼을 앞으로
// 당긴다. 접힌 머리줄이 그 자체로 '무슨 안내인지 + 보상이 있다'를 한 줄로 말하므로,
// 접혀 있어도 동기(선착순 보상)는 사라지지 않는다. 그냥 둘러보다 규칙이 궁금한
// 사람에겐(일반 진입) 펼친 채로 둔다.

export function CollapsibleGuide({
  targets,
  quota,
  remaining,
  defaultOpen,
}: {
  targets: string[];
  quota: number;
  remaining: number;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className={g.wrap}>
      {/* 작은 알약 토글 — 큰 카드가 아니라 '펼칠 수 있는 링크'로 읽히게 (2026-08-27) */}
      <button
        type="button"
        className={g.toggle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={g.chev} data-open={open} aria-hidden>
          ›
        </span>
        신고 대상·보상 안내
      </button>

      {open && (
        <div className={g.body}>
          <h3 className={g.h3}>신고 대상 행위</h3>
          <ul className={g.list}>
            {targets.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>

          <h3 className={g.h3}>보상과 절차</h3>
          <p className={g.p}>
            접수된 신고는 운영자가 직접 검토하며, 위반이 확인된 신고에 한해 선착순 {quota}건까지
            보상을 드립니다 (현재 잔여 {remaining.toLocaleString()}건). 같은 리포트에 여러 신고가
            들어오면 <b className={g.strong}>가장 먼저 신고하신 분</b>에게 보상이 갑니다. 검토
            결과는 알림으로 안내되며, 보상 지급 방법은 확인 후 개별로 안내드립니다.
          </p>
        </div>
      )}
    </section>
  );
}
