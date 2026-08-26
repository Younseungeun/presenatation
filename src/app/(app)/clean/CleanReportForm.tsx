"use client";

import { useState } from "react";
import {
  ABUSE_CATEGORIES,
  ABUSE_CATEGORY_LABEL,
  type AbuseCategory,
} from "@/server/abuseReportService";
import styles from "../researcher/researcher.module.css";
import s from "./cleanReport.module.css";

// 신고 접수 폼 — POST /api/abuse-reports.
//
// **본문을 산 사람에게는 검수 상세(FlaggedReport)와 같은 카드로 보여준다** (2026-08-27 창업자
// 지시). 리포트 본문을 문장으로 펼치고, 신고자가 **문제되는 문장을 눌러 유형을 붙인다.**
// 그러면 운영자의 "이용자가 잡은 것"이 검수 모델이 잡은 것과 같은 모양(부분 + 유형)이 되고,
// 강제 철회 시 그 지적이 교사 질문지에 그대로 실린다.
//
// 본문을 못 보는 경우(구매 전·리포트 없는 신고)는 종전대로 자유 입력만 받는다.

/** 신고자가 짚은 한 부분 — 문장 + 유형 */
interface Part {
  quote: string;
  category: AbuseCategory;
}

/** 본문을 문장 단위로 쪼갠다 — 줄바꿈 + 종결 부호. 마크다운 머리표(##·-·1.)는 걷고 빈 조각은 버린다 */
function splitSentences(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?。])\s+/))
    .map((x) => x.replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

export function CleanReportForm({
  reportId,
  fixedTargetName,
  reportBody,
}: {
  reportId?: string;
  fixedTargetName?: string;
  /** 산 사람에게만 온다 — 본문을 카드로 펼쳐 문장을 고르게 한다 */
  reportBody?: { title: string; content: string } | null;
} = {}) {
  const [category, setCategory] = useState<AbuseCategory>("ONE_ON_ONE");
  const [targetName, setTargetName] = useState(fixedTargetName ?? "");
  const [detail, setDetail] = useState("");
  const [parts, setParts] = useState<Part[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const sentences = reportBody ? splitSentences(reportBody.content) : [];
  const selectedQuotes = new Set(parts.map((p) => p.quote));

  function toggleSentence(quote: string) {
    setParts((prev) =>
      prev.some((p) => p.quote === quote)
        ? prev.filter((p) => p.quote !== quote)
        : [...prev, { quote, category }],
    );
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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/abuse-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetName,
          // 대표 유형 — 지적한 부분이 있으면 그 첫 유형을, 없으면 위에서 고른 유형을 쓴다
          category: parts[0]?.category ?? category,
          detail,
          reportId,
          // 문장별 지적 (있을 때만) — 운영자 화면이 이것으로 카드를 그린다
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

  return (
    <form onSubmit={submit} className={styles.form}>
      {reportBody ? (
        // ── 본문을 산 사람: 문장을 눌러 유형을 붙인다 (검수 카드와 같은 방식) ──
        <>
          <div className={s.card}>
            <div className={s.top}>
              <span className={s.title}>{reportBody.title}</span>
              {parts.length > 0 && <span className={s.count}>{parts.length}곳 지적</span>}
            </div>
            <div className={s.bodyBox}>
              <p className={s.hint}>문제되는 문장을 눌러 표시하세요.</p>
              {sentences.map((sen, i) => {
                const on = selectedQuotes.has(sen);
                return (
                  <button
                    type="button"
                    key={i}
                    className={`${s.sentence} ${on ? s.sentenceOn : ""}`}
                    onClick={() => toggleSentence(sen)}
                    aria-pressed={on}
                  >
                    {sen}
                  </button>
                );
              })}
            </div>
          </div>

          {parts.length > 0 && (
            <div className={s.picks}>
              <div className={styles.label} style={{ marginBottom: 4 }}>
                지적한 부분마다 어떤 행위인가요?
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
                      onClick={() => toggleSentence(p.quote)}
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
        // ── 본문을 못 보는 경우: 종전 자유 입력 ──
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
              ? "표시한 문장이 왜 문제인지, 언제·어디서 겪었는지 등을 적어 주세요."
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
