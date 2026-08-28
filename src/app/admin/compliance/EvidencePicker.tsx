"use client";

import { useRef, useState } from "react";
import a from "../admin.module.css";

// 근거 문장 지목 (회신 20호 요청 3) — 운영자가 반려·철회 때 본문에서 위반 문장을 드래그로
// 짚는다. IRIS 는 문서를 2문장 창으로 쪼개 배우므로, 지목이 있으면 그 문장 창만 위반으로,
// 나머지는 정상으로 나눠 쓴다. **권장(선택)** — 안 짚으면 종전대로 문서 라벨.
//
// /clean 의 커스텀 스와이프 선택을 트림한 것: 글자마다 data-i span → 드래그로 손가락/커서
// 아래 글자를 elementFromPoint 로 추적. touch-action:none 으로 스크롤이 아니라 선택으로 잡는다.

export function EvidencePicker({
  content,
  value,
  onChange,
  cardText,
  required = false,
}: {
  content: string | null;
  value: string[];
  onChange: (quotes: string[]) => void;
  /** 필수 지목이면 처음부터 펼치고 토글 문구를 "(선택)" 대신 그대로 둔다 */
  required?: boolean;
  /**
   * 예측 카드에서 온 값(종목·방향·목표·기간) — 본문에 글로 없는 항목 (2026-08-28 창업자 지시).
   * 비현실적 예측·카드 불일치처럼 위반이 카드에 있는 유형은 본문에서 문장을 못 찾으므로,
   * 이 줄을 본문 위에 **다른 글꼴로** 실어 짚게 한다. IRIS 입력에는 카드가 통째로 들어간다.
   */
  cardText?: string | null;
}) {
  const [open, setOpen] = useState(required);
  const [range, setRange] = useState<[number, number] | null>(null);
  const dragging = useRef(false);
  const startIdx = useRef<number | null>(null);
  const lastIdx = useRef<number | null>(null);

  const body = content ?? "";
  // 카드 줄을 본문 앞에 붙여 한 글자 흐름으로 만든다 — 짚기(elementFromPoint·indexOf)가
  // 카드 값이든 본문 문장이든 똑같이 동작한다. 경계 앞쪽이 카드 영역이라 글꼴을 달리한다
  const card = cardText?.trim() ? cardText.trim() : "";
  const SEP = "\n";
  const text = card ? card + SEP + body : body;
  const cardLen = card ? card.length : 0;
  if (!text.trim()) return null;

  const idxAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const raw = el?.dataset?.i;
    return raw == null ? null : Number(raw);
  };
  const onDown = (e: React.PointerEvent) => {
    const i = idxAt(e.clientX, e.clientY);
    if (i == null) return;
    e.preventDefault();
    dragging.current = true;
    startIdx.current = i;
    lastIdx.current = i;
    setRange([i, i]);
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current || startIdx.current == null) return;
    const i = idxAt(e.clientX, e.clientY);
    if (i == null) return;
    lastIdx.current = i;
    const s = startIdx.current;
    setRange([Math.min(s, i), Math.max(s, i)]);
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const s = startIdx.current;
    const en = lastIdx.current;
    startIdx.current = null;
    lastIdx.current = null;
    setRange(null);
    // 움직였을 때만 (누르고 뗀 것은 오조작)
    if (s != null && en != null && s !== en) {
      const q = text.slice(Math.min(s, en), Math.max(s, en) + 1).trim();
      if (q && !value.includes(q)) onChange([...value, q]);
    }
  };
  const remove = (q: string) => onChange(value.filter((x) => x !== q));

  // 이미 짚은 부분 표시 — 모든 등장 위치
  const picked = new Array<boolean>(text.length).fill(false);
  for (const q of value) {
    if (!q) continue;
    let from = 0;
    for (;;) {
      const at = text.indexOf(q, from);
      if (at < 0) break;
      for (let i = at; i < at + q.length; i++) picked[i] = true;
      from = at + q.length;
    }
  }

  return (
    <div style={{ marginTop: 8 }}>
      <button type="button" className={a.chip} onClick={() => setOpen((o) => !o)}>
        {open
          ? "근거 문장 접기 ▴"
          : `근거 문장 짚기${required ? "" : " (선택)"}${value.length ? ` · ${value.length}곳` : ""} ▾`}
      </button>
      {open && (
        <div style={{ marginTop: 6 }}>
          <p className={a.hint}>
            본문에서 위반 근거 문장을 드래그로 짚으세요 — IRIS 가 그 문장 창만 위반으로 배웁니다
            (안 짚으면 문서 전체 라벨).
          </p>
          <div
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            style={{
              border: "1px solid var(--line)",
              borderRadius: 8,
              padding: "10px 12px",
              background: "var(--surface-1, #f2f4f6)",
              userSelect: "none",
              WebkitUserSelect: "none",
              touchAction: "none",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 13.5,
              lineHeight: 1.8,
              maxHeight: "40vh",
              overflowY: "auto",
              cursor: "crosshair",
            }}
          >
            {Array.from(text).map((ch, i) => {
              const live = range != null && i >= range[0] && i <= range[1];
              // 카드 영역(경계 앞)은 **본문과 다른 글꼴** — 종목·수익률이 리서처가 쓴
              // 본문 문장이 아니라 예측 카드에서 온 값임을 눈으로 가른다
              const inCard = i < cardLen;
              const base: React.CSSProperties = inCard
                ? { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontStyle: "italic", color: "#5b6472" }
                : {};
              const style: React.CSSProperties | undefined = live
                ? { ...base, background: "rgba(18,184,150,0.28)", color: "#0e6f5c" }
                : picked[i]
                  ? { ...base, background: "#f7ebeb", color: "#bd4242" }
                  : inCard
                    ? base
                    : undefined;
              return (
                <span key={i} data-i={i} style={style}>
                  {ch}
                </span>
              );
            })}
          </div>
          {value.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {value.map((q) => (
                <span key={q} className={a.chip} style={{ color: "#bd4242" }}>
                  &ldquo;{q.length > 24 ? q.slice(0, 24) + "…" : q}&rdquo;
                  <button
                    type="button"
                    onClick={() => remove(q)}
                    aria-label="빼기"
                    style={{
                      marginLeft: 6,
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      color: "var(--text-faint)",
                    }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
