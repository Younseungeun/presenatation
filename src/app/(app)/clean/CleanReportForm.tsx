"use client";

import { useEffect, useRef, useState } from "react";
import {
  ABUSE_CATEGORIES,
  ABUSE_CATEGORY_SHORT,
  DAILY_REPORT_LIMIT,
  type AbuseCategory,
} from "@/server/abuseReportService";
import styles from "../researcher/researcher.module.css";
import s from "./cleanReport.module.css";

// 신고 접수 폼 — POST /api/abuse-reports.
//
// **본문 선택 = 버튼을 누른 뒤 손가락으로 쓸어 고르는 커스텀 스와이프** (2026-08-27 창업자 지시).
// 네이티브 텍스트 선택(길게 눌러 드래그)은 ① 모바일에서 길게 누르는 법을 모르는 사람이 있고
// ② OS 기본 선택 핸들이 떠서 "웹페이지"처럼 보여 앱의 기능으로 읽히지 않는다. 그래서 본문의
// user-select 를 아예 죽이고(네이티브 선택 불가), "본문 선택하기" 버튼으로 선택 모드에 들어간
// 뒤 손가락으로 쓸면(pointer 이벤트) 그 구간만 칠해지게 한다 — 길게 누를 필요가 없다.
//
// 본문은 글자마다 data-i span 으로 그려, 스와이프 중 손가락 아래 글자를 elementFromPoint 로
// 추적해 시작~현재 구간을 라이브로 칠한다. 손을 떼면 그 구간이 pending → 유형을 붙여 추가.
// 본문을 못 보는 경우(구매 전·리포트 없는 신고)는 종전대로 자유 입력만 받는다.
// (커스텀 스와이프 선택 — pointer 이벤트 기반)

interface Part {
  quote: string;
  category: AbuseCategory;
}

/** 본문에서 지적된 부분(모든 등장 위치)을 글자 단위 마스크로 표시한다 */
function partMask(content: string, quotes: string[]): boolean[] {
  const mask = new Array<boolean>(content.length).fill(false);
  for (const q of quotes) {
    if (!q) continue;
    let from = 0;
    for (;;) {
      const at = content.indexOf(q, from);
      if (at < 0) break;
      for (let i = at; i < at + q.length; i++) mask[i] = true;
      from = at + q.length;
    }
  }
  return mask;
}

export function CleanReportForm({
  reportId,
  fixedTargetName,
  reportBody,
}: {
  reportId?: string;
  fixedTargetName?: string;
  /** 산 사람에게만 온다 — 본문을 통째로 펼쳐 스와이프로 부분을 고르게 한다 */
  reportBody?: { title: string; content: string } | null;
} = {}) {
  const [category, setCategory] = useState<AbuseCategory>("ONE_ON_ONE");
  const [targetName, setTargetName] = useState(fixedTargetName ?? "");
  const [detail, setDetail] = useState("");
  const [parts, setParts] = useState<Part[]>([]);
  // 지금 스와이프로 잡은(아직 유형 안 붙인) 선택 — 유형 칩을 누르면 그 자리에서 추가된다
  const [pending, setPending] = useState("");
  // 지적 목록에서 유형을 다시 고르는 중인 행(인용문). 평소엔 유형이 칩으로 접혀 있다
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // 신고 접수 직전 유의사항 확인창 (진짜 접수 전 마지막 고지)
  const [confirming, setConfirming] = useState(false);

  // 커스텀 스와이프 선택 상태
  const [selectMode, setSelectMode] = useState(false);
  const [range, setRange] = useState<[number, number] | null>(null); // [lo, hi] 글자 인덱스(양끝 포함)
  const bodyRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startIdx = useRef<number | null>(null);
  const lastIdx = useRef<number | null>(null);
  // 드래그 중 손가락(커서) 위치와 가장자리 자동 스크롤 루프
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const raf = useRef<number | null>(null);
  // 선택 모드 여부의 ref 거울 — non-passive touchmove 핸들러가 읽는다(아래 useEffect)
  const selectModeRef = useRef(false);

  const content = reportBody?.content ?? "";

  /** 화면 좌표 아래 글자의 인덱스 — span 의 data-i 를 읽는다 */
  function idxAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const raw = el?.dataset?.i;
    return raw == null ? null : Number(raw);
  }

  // 가장자리 자동 스크롤이 발동하는 띠의 두께 (박스 위·아래 끝 기준)
  const EDGE = 52;

  /** 자동 스크롤로 손가락이 박스 밖으로 나가도, **박스 안 보이는 맨 끝 글자**를 집도록
   *  표본 y 를 박스의 보이는 구간 안으로 접는다 */
  function sampleIndexAt(x: number, y: number): number | null {
    const box = bodyRef.current;
    if (!box) return idxAt(x, y);
    const r = box.getBoundingClientRect();
    const sy = Math.min(Math.max(y, r.top + 2), r.bottom - 2);
    return idxAt(x, sy);
  }

  function extendTo(i: number | null) {
    if (i == null || startIdx.current == null) return;
    lastIdx.current = i;
    const a = startIdx.current;
    setRange([Math.min(a, i), Math.max(a, i)]);
  }

  // 데스크톱 텍스트 선택과 같은 **가장자리 자동 스크롤** — 단, 창이 아니라 **박스 안**을
  // 굴린다 (2026-08-27 창업자 지시: 선택 버튼을 눌러도 페이지 전체가 움직이지 않고 박스만
  // 스크롤). 드래그 중 손가락이 박스 위/아래 끝 띠에 들어가면 박스가 저절로 스크롤되고,
  // 그동안 드러나는 글자로 선택 끝이 이어진다. touch-action: none 이라 네이티브 스크롤이
  // 막혀 있어 직접 scrollTop 으로 굴린다.
  function edgeScroll() {
    raf.current = null;
    const box = bodyRef.current;
    if (!dragging.current || !pointer.current || !box) return;
    const { x, y } = pointer.current;
    const r = box.getBoundingClientRect();
    let dy = 0;
    if (y < r.top + EDGE) dy = -(6 + Math.floor((r.top + EDGE - y) / 5));
    else if (y > r.bottom - EDGE) dy = 6 + Math.floor((y - (r.bottom - EDGE)) / 5);
    dy = Math.max(-26, Math.min(26, dy));
    if (dy !== 0) {
      const before = box.scrollTop;
      box.scrollTop += dy;
      // 실제로 스크롤됐을 때만(끝에 닿으면 안 움직인다) 선택을 잇는다
      if (box.scrollTop !== before) extendTo(sampleIndexAt(x, y));
    }
    raf.current = requestAnimationFrame(edgeScroll);
  }
  function startEdgeLoop() {
    if (raf.current == null) raf.current = requestAnimationFrame(edgeScroll);
  }
  function stopEdgeLoop() {
    if (raf.current != null) {
      cancelAnimationFrame(raf.current);
      raf.current = null;
    }
  }
  // 드래그 도중 화면을 떠나도(언마운트) 루프가 남지 않게
  useEffect(() => stopEdgeLoop, []);

  // selectMode 의 ref 거울 — 아래 native touchmove 핸들러가 최신 값을 읽게
  useEffect(() => {
    selectModeRef.current = selectMode;
  }, [selectMode]);

  // **모바일 세로 드래그가 선택으로 잡히게 하는 핵심** — 선택 모드 동안 브라우저의 터치
  // 스크롤을 코드로 막는다. touch-action: none 은 스크롤 컨테이너(overflow-y:auto)와
  // 겹치면 일부 기기에서 무시되어, 세로 드래그가 스크롤로 채여 pointercancel 이 뜨고
  // 드래그가 끊긴다(→ 두 줄 이상 선택 불가). React onTouchMove 는 passive 라
  // preventDefault 가 안 먹으므로, non-passive 로 직접 붙인다. 스크롤이 필요하면(자동
  // 스크롤) 우리가 scrollTop 으로 직접 굴린다
  useEffect(() => {
    const box = bodyRef.current;
    if (!box) return;
    const block = (e: TouchEvent) => {
      if (selectModeRef.current) e.preventDefault();
    };
    box.addEventListener("touchmove", block, { passive: false });
    return () => box.removeEventListener("touchmove", block);
  }, []);

  function enterSelect() {
    setPending("");
    setRange(null);
    setSelectMode(true);
  }
  function exitSelect() {
    dragging.current = false;
    startIdx.current = null;
    lastIdx.current = null;
    setRange(null);
    setSelectMode(false);
  }

  function onDown(e: React.PointerEvent) {
    if (!selectMode) return;
    const i = idxAt(e.clientX, e.clientY);
    if (i == null) return;
    // 상자는 touch-action: none 이라 이 드래그가 스크롤로 새지 않는다 — 방향과 무관하게
    // (여러 줄에 걸쳐도) 손가락 아래 글자를 따라 선택된다
    e.preventDefault();
    // 포인터 캡처 — 손가락이 상자 밖(하단 탭바 위)으로 나가도 move 를 계속 받아야
    // 가장자리 자동 스크롤이 이어진다
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // 캡처 불가 환경에서도 선택 자체는 동작한다
    }
    dragging.current = true;
    startIdx.current = i;
    lastIdx.current = i;
    pointer.current = { x: e.clientX, y: e.clientY };
    setRange([i, i]);
    startEdgeLoop();
  }
  function onMove(e: React.PointerEvent) {
    if (!dragging.current || startIdx.current == null) return;
    pointer.current = { x: e.clientX, y: e.clientY };
    // 상자 안 글자 위면 그 글자로, 밖(탭바 위 등)이면 갱신은 자동 스크롤 루프에 맡긴다
    const i = idxAt(e.clientX, e.clientY);
    if (i != null) extendTo(i);
  }
  function onUp() {
    if (!dragging.current) return;
    dragging.current = false;
    stopEdgeLoop();
    pointer.current = null;
    const a = startIdx.current;
    const b = lastIdx.current;
    startIdx.current = null;
    lastIdx.current = null;
    setRange(null);
    setSelectMode(false);
    if (a != null && b != null) {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const q = content.slice(lo, hi + 1).trim();
      if (q) setPending(q);
    }
  }

  // 유형 칩을 누르는 순간 그 유형으로 지적이 확정된다 — 고르기와 추가가 한 동작
  function commitPending(cat: AbuseCategory) {
    const q = pending.trim();
    if (!q) return;
    setParts((prev) =>
      prev.some((p) => p.quote === q) ? prev : [...prev, { quote: q, category: cat }],
    );
    setPending("");
  }
  function removePart(quote: string) {
    setParts((prev) => prev.filter((p) => p.quote !== quote));
    setEditing((e) => (e === quote ? null : e));
  }
  function setPartCategory(quote: string, c: AbuseCategory) {
    setParts((prev) => prev.map((p) => (p.quote === quote ? { ...p, category: c } : p)));
    setEditing(null);
  }

  // 유형 칩 한 줄 — 상단 '신고 대상 행위'와 같은 4가지를 고르는 자리. selected 를 주면
  // 그 칩이 채워진다(단일 선택 표시). null 이면 '누르면 곧 확정'(pending)
  const chipRow = (selected: AbuseCategory | null, onPick: (c: AbuseCategory) => void) => (
    <div className={s.chips}>
      {ABUSE_CATEGORIES.map((c) => (
        <button
          key={c}
          type="button"
          className={`${s.chip} ${selected === c ? s.chipOn : ""}`}
          aria-pressed={selected === c}
          onClick={() => onPick(c)}
        >
          {ABUSE_CATEGORY_SHORT[c]}
        </button>
      ))}
    </div>
  );

  if (done) {
    return (
      <p className={styles.sub}>
        ✅ 신고가 접수되었습니다. 운영자 검토 후 결과를 알림으로 안내드립니다. 클린 리서치에
        함께해 주셔서 감사합니다.
      </p>
    );
  }

  // 접수 버튼 → 폼 검증(required)을 거친 뒤 확인창을 연다. 실제 접수는 확인창에서
  const openConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    setConfirming(true);
  };

  const doSubmit = async () => {
    setConfirming(false);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/abuse-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetName,
          category: parts[0]?.category ?? category,
          detail,
          reportId,
          findings: parts.length ? parts : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "접수에 실패했습니다");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "접수에 실패했습니다");
    } finally {
      setBusy(false);
    }
  };

  const mask = reportBody ? partMask(content, parts.map((p) => p.quote)) : [];
  // 본문을 볼 수 있는 사람(구매자)인데 한 곳도 안 짚었으면, 접수 직전에 한 번 권한다.
  // 강제는 안 한다 — '본문 전체가 문제'인 신고도 있어서. 넛지만 주고 결정은 신고자에게
  const noPartsNudge = !!reportBody && parts.length === 0;

  return (
    <form onSubmit={openConfirm} className={styles.form}>
      {/* 신고 접수 직전 유의사항 확인창 (2026-08-27 창업자 지시) */}
      {confirming && (
        <div className={s.modalBackdrop} onClick={() => setConfirming(false)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalTitle}>신고를 접수하기 전에</div>
            {noPartsNudge && (
              <p className={s.modalNudge}>
                본문에서 <b>문제되는 부분을 아직 짚지 않으셨어요.</b> 짚어 주시면 어디가
                왜 문제인지 운영자가 바로 보게 되어 검토가 빨라집니다. 그대로 접수하셔도
                됩니다.
              </p>
            )}
            <p className={s.modalBody}>
              신고는 1인당 하루 {DAILY_REPORT_LIMIT}건까지 접수할 수 있습니다. 사실과 다른
              내용을 고의로 신고하거나 허위 신고를 반복하면 보상 대상에서 제외되고 서비스
              이용이 제한될 수 있습니다.
            </p>
            <div className={s.modalBtns}>
              <button
                type="button"
                className={s.modalCancel}
                onClick={() => setConfirming(false)}
              >
                취소
              </button>
              <button type="button" className={s.modalOk} onClick={doSubmit}>
                확인하고 접수
              </button>
            </div>
          </div>
        </div>
      )}

      {reportBody ? (
        <>
          <div className={s.card}>
            <div className={s.top}>
              <span className={s.title}>{reportBody.title}</span>
              {parts.length > 0 && <span className={s.count}>{parts.length}곳 지적</span>}
            </div>

            {/* 본문 선택 컨트롤 — 버튼을 눌러 선택 모드에 들어간 뒤 손가락으로 쓴다 */}
            {selectMode ? (
              <div className={s.selectingBar}>
                <span className={s.selectingDot} aria-hidden />
                <span className={s.selectingText}>
                  손가락으로 본문을 <b>쓸어서</b> 선택 — 손을 떼면 유형을 붙입니다
                </span>
                <button type="button" className={s.selectCancel} onClick={exitSelect}>
                  취소
                </button>
              </div>
            ) : (
              <>
                <button type="button" className={s.selectBtn} onClick={enterSelect}>
                  <span className={s.selectBtnIcon} aria-hidden>
                    ✎
                  </span>
                  본문에서 문제되는 부분 선택
                </button>
                <p className={s.guide}>
                  버튼을 누르고 손가락으로 <b>쓸면</b> 됩니다 — 길게 누를 필요 없어요.
                </p>
              </>
            )}

            <div
              ref={bodyRef}
              className={`${s.bodyBox} ${selectMode ? s.selecting : ""}`}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onUp}
            >
              <p className={s.bodyText}>
                {Array.from(content).map((ch, i) => {
                  const live = range != null && i >= range[0] && i <= range[1];
                  const cls = live ? s.live : mask[i] ? s.mark : undefined;
                  return (
                    <span key={i} data-i={i} className={cls}>
                      {ch}
                    </span>
                  );
                })}
              </p>
            </div>
          </div>

          {/* 방금 스와이프로 잡은 부분 — 유형 칩을 누르면 그 유형으로 확정된다 */}
          {pending && (
            <div className={s.pendingBar}>
              <div className={s.pendingHead}>
                <span className={s.pickQuote}>&ldquo;{pending}&rdquo;</span>
                <button
                  type="button"
                  className={s.pickRemove}
                  onClick={() => setPending("")}
                  aria-label="선택 취소"
                >
                  ✕
                </button>
              </div>
              <div className={s.pendingAsk}>이 부분은 어떤 행위인가요?</div>
              {chipRow(null, commitPending)}
            </div>
          )}

          {/* 지적한 부분 목록 — 유형 필을 누르면 칩으로 다시 고를 수 있다 */}
          {parts.length > 0 && (
            <div className={s.picks}>
              <div className={styles.label} style={{ marginBottom: 4 }}>
                지적한 부분 ({parts.length})
              </div>
              {parts.map((p) => (
                <div key={p.quote} className={s.pickRow}>
                  <div className={s.pickTop}>
                    <span className={s.pickQuote}>&ldquo;{p.quote}&rdquo;</span>
                    <button
                      type="button"
                      className={s.pickRemove}
                      onClick={() => removePart(p.quote)}
                      aria-label="지적 취소"
                    >
                      ✕
                    </button>
                  </div>
                  {editing === p.quote ? (
                    chipRow(p.category, (c) => setPartCategory(p.quote, c))
                  ) : (
                    <button
                      type="button"
                      className={s.typePill}
                      onClick={() => setEditing(p.quote)}
                    >
                      {ABUSE_CATEGORY_SHORT[p.category]}
                      <span className={s.typePillEdit} aria-hidden>
                        ✎
                      </span>
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className={styles.label}>
          어떤 행위인가요?
          {chipRow(category, setCategory)}
        </div>
      )}

      {reportId ? (
        <p className={styles.sub} style={{ margin: 0 }}>
          신고 대상: <strong>{targetName}</strong>
        </p>
      ) : (
        <label className={styles.label}>
          대상 (리서처 필명 또는 리포트 제목)
          <input
            className={styles.input}
            value={targetName}
            onChange={(e) => setTargetName(e.target.value)}
            placeholder="예: 크립토애널리스트 / 비트코인 4분기 전망"
            required
            maxLength={200}
          />
        </label>
      )}

      <label className={styles.label}>
        정황·근거 (10자 이상)
        <textarea
          className={styles.input}
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          placeholder={
            reportBody
              ? "선택한 부분이 왜 문제인지, 언제·어디서 겪었는지 등을 적어 주세요."
              : "언제, 어디서(리포트 본문·댓글 등), 어떤 내용이 있었는지 적어 주세요. 캡처가 있다면 내용을 옮겨 적어 주세요."
          }
          rows={5}
          required
          minLength={10}
          maxLength={4000}
        />
      </label>

      {error && <p className={styles.error}>{error}</p>}

      <button type="submit" className={styles.primaryBtn} disabled={busy}>
        {busy ? "접수 중…" : "신고 접수"}
      </button>
    </form>
  );
}
