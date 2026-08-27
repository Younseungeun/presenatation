"use client";

import { useRef, useState } from "react";
import {
  ABUSE_CATEGORIES,
  ABUSE_CATEGORY_LABEL,
  DAILY_REPORT_LIMIT,
  type AbuseCategory,
} from "@/server/abuseReportService";
import styles from "../researcher/researcher.module.css";
import s from "./cleanReport.module.css";

// 신고 접수 폼 — POST /api/abuse-reports.
//
// **본문을 통째로 보여주고, 신고자가 드래그로 시작·끝을 직접 잡아 부분을 고른다**
// (2026-08-27 창업자 지시). 문장 단위로 끊어 고르던 방식은 위반이 문장 중간에 걸치거나
// 여러 문장에 걸칠 때 정확히 못 짚는다. 드래그 선택은 그 경계를 사람이 정한다.
// 고른 부분마다 유형을 붙이면 운영자의 "이용자가 잡은 것"이 검수 모델이 잡은 것과 같은
// 모양(부분 + 유형)이 되고, 강제 철회 시 교사 질문지에 실린다.
//
// 본문을 못 보는 경우(구매 전·리포트 없는 신고)는 종전대로 자유 입력만 받는다.

interface Part {
  quote: string;
  category: AbuseCategory;
}

/** 본문을 지적된 부분 기준으로 조각낸다 — 겹치면 합친다 */
function highlight(text: string, quotes: string[]): { text: string; on: boolean }[] {
  const spans: { start: number; end: number }[] = [];
  for (const q of quotes) {
    const at = text.indexOf(q);
    if (at >= 0) spans.push({ start: at, end: at + q.length });
  }
  if (spans.length === 0) return [{ text, on: false }];
  spans.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.start <= last.end) last.end = Math.max(last.end, sp.end);
    else merged.push({ ...sp });
  }
  const out: { text: string; on: boolean }[] = [];
  let cur = 0;
  for (const m of merged) {
    if (m.start > cur) out.push({ text: text.slice(cur, m.start), on: false });
    out.push({ text: text.slice(m.start, m.end), on: true });
    cur = m.end;
  }
  if (cur < text.length) out.push({ text: text.slice(cur), on: false });
  return out;
}

export function CleanReportForm({
  reportId,
  fixedTargetName,
  reportBody,
}: {
  reportId?: string;
  fixedTargetName?: string;
  /** 산 사람에게만 온다 — 본문을 통째로 펼쳐 드래그로 부분을 고르게 한다 */
  reportBody?: { title: string; content: string } | null;
} = {}) {
  const [category, setCategory] = useState<AbuseCategory>("ONE_ON_ONE");
  const [targetName, setTargetName] = useState(fixedTargetName ?? "");
  const [detail, setDetail] = useState("");
  const [parts, setParts] = useState<Part[]>([]);
  // 지금 드래그로 잡은(아직 유형 안 붙인) 선택
  const [pending, setPending] = useState("");
  const [pendingCat, setPendingCat] = useState<AbuseCategory>("ONE_ON_ONE");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // 신고 접수 직전 유의사항 확인창 (진짜 접수 전 마지막 고지)
  const [confirming, setConfirming] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const content = reportBody?.content ?? "";

  function captureSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    // 본문 상자 안의 선택만 받는다
    if (!bodyRef.current || !bodyRef.current.contains(sel.anchorNode)) return;
    const text = sel.toString().trim();
    // 본문에 실제로 있는 연속 구간만 (하이라이트 조각을 넘나든 선택은 버린다)
    if (!text || !content.includes(text)) return;
    setPending(text);
  }

  function addPending() {
    const q = pending.trim();
    if (!q) return;
    setParts((prev) =>
      prev.some((p) => p.quote === q) ? prev : [...prev, { quote: q, category: pendingCat }],
    );
    setPending("");
    window.getSelection()?.removeAllRanges();
  }
  function removePart(quote: string) {
    setParts((prev) => prev.filter((p) => p.quote !== quote));
  }
  function setPartCategory(quote: string, c: AbuseCategory) {
    setParts((prev) => prev.map((p) => (p.quote === quote ? { ...p, category: c } : p)));
  }

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

  const segments = reportBody ? highlight(content, parts.map((p) => p.quote)) : [];

  return (
    <form onSubmit={openConfirm} className={styles.form}>
      {/* 신고 접수 직전 유의사항 확인창 (2026-08-27 창업자 지시) */}
      {confirming && (
        <div className={s.modalBackdrop} onClick={() => setConfirming(false)}>
          <div className={s.modal} onClick={(e) => e.stopPropagation()}>
            <div className={s.modalTitle}>신고를 접수하기 전에</div>
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
            <p className={s.guide}>
              문제되는 부분을 <b>드래그로 선택</b>하세요 — 시작과 끝을 직접 잡으면 됩니다.
            </p>
            <div
              ref={bodyRef}
              className={s.bodyBox}
              onMouseUp={captureSelection}
              onTouchEnd={captureSelection}
            >
              <p className={s.bodyText}>
                {segments.map((seg, i) =>
                  seg.on ? (
                    <mark key={i} className={s.mark}>
                      {seg.text}
                    </mark>
                  ) : (
                    <span key={i}>{seg.text}</span>
                  ),
                )}
              </p>
            </div>
          </div>

          {/* 방금 드래그로 잡은 부분 — 유형을 붙여 추가한다 */}
          {pending && (
            <div className={s.pendingBar}>
              <span className={s.pickQuote}>&ldquo;{pending}&rdquo;</span>
              <div className={s.pickCtrl}>
                <select
                  className={s.pickSelect}
                  value={pendingCat}
                  onChange={(e) => setPendingCat(e.target.value as AbuseCategory)}
                >
                  {ABUSE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {ABUSE_CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
                <button type="button" className={s.addBtn} onClick={addPending}>
                  지적 추가
                </button>
                <button
                  type="button"
                  className={s.pickRemove}
                  onClick={() => setPending("")}
                  aria-label="선택 취소"
                >
                  ✕
                </button>
              </div>
            </div>
          )}

          {/* 지적한 부분 목록 — 유형 바꾸기·빼기 */}
          {parts.length > 0 && (
            <div className={s.picks}>
              <div className={styles.label} style={{ marginBottom: 4 }}>
                지적한 부분 ({parts.length})
              </div>
              {parts.map((p) => (
                <div key={p.quote} className={s.pickRow}>
                  <span className={s.pickQuote}>&ldquo;{p.quote}&rdquo;</span>
                  <div className={s.pickCtrl}>
                    <select
                      className={s.pickSelect}
                      value={p.category}
                      onChange={(e) => setPartCategory(p.quote, e.target.value as AbuseCategory)}
                    >
                      {ABUSE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {ABUSE_CATEGORY_LABEL[c]}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={s.pickRemove}
                      onClick={() => removePart(p.quote)}
                      aria-label="지적 취소"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <label className={styles.label}>
          어떤 행위인가요?
          <select
            className={styles.input}
            value={category}
            onChange={(e) => setCategory(e.target.value as AbuseCategory)}
          >
            {ABUSE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {ABUSE_CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
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
