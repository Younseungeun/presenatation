"use client";

import { useState } from "react";
import a from "../admin.module.css";

// 학습 표현의 매칭 증거 (회신 20호 요청 2) — 승격·졸업 심사의 재료.
//
// 숫자(정탐률·부정 수)만으로는 "코드로 굳혀도 되나 / ARGOS에 넘겨도 되나"를 못 정한다.
// **실제 걸린 문장·출현형·부정·판정**을 나란히 봐야 사람이 판단한다. 목록 렌더를 무겁게
// 하지 않으려고 펼칠 때 지연 로드한다(전 표현을 미리 부르지 않는다).

interface EvidenceRow {
  sentence: string | null;
  surface: string | null;
  negation: string | null;
  verdict: string | null;
  createdAt: string;
}

const VERDICT_LABEL: Record<string, string> = {
  REJECTED: "반려",
  TAKEDOWN: "철회",
  MISSED: "미탐",
  APPROVED: "승인",
  KEPT: "유지",
};

/** 문맥 안에서 실제 출현형만 진하게 — 어미 변형·회피 표기가 곧장 보이게 */
function HiSurface({ sentence, surface }: { sentence: string; surface: string | null }) {
  if (!surface || !sentence.includes(surface)) return <>{sentence}</>;
  const at = sentence.indexOf(surface);
  return (
    <>
      {sentence.slice(0, at)}
      <mark style={{ background: "#f7ebeb", color: "#bd4242", padding: "0 2px", borderRadius: 3 }}>
        {surface}
      </mark>
      {sentence.slice(at + surface.length)}
    </>
  );
}

export function PhraseEvidence({ phraseId, count }: { phraseId: string; count: number }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<EvidenceRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (rows || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/compliance/phrase-evidence?phraseId=${encodeURIComponent(phraseId)}`,
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "증거를 불러오지 못했습니다");
      setRows(json as EvidenceRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다");
    } finally {
      setBusy(false);
    }
  };

  // 아직 한 번도 안 걸린 항목은 보여줄 증거가 없다
  if (count === 0) return null;

  return (
    <div style={{ marginTop: 6 }}>
      <button type="button" className={a.chip} onClick={toggle}>
        {open ? "증거 접기 ▴" : `걸린 문장 ${count}건 보기 ▾`}
      </button>
      {open && (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
          {busy && <p className={a.hint}>불러오는 중…</p>}
          {error && (
            <p className={a.hint} style={{ color: "var(--warn)" }}>
              {error}
            </p>
          )}
          {rows?.length === 0 && !busy && (
            <p className={a.hint}>박제된 문장이 없습니다 (스냅샷 도입 전 매칭).</p>
          )}
          {rows?.map((r, i) => (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                paddingBottom: 6,
                borderBottom: "1px solid var(--line)",
              }}
            >
              <span className={a.quote} style={{ whiteSpace: "normal" }}>
                {r.sentence ? (
                  <HiSurface sentence={r.sentence} surface={r.surface} />
                ) : (
                  <span className={a.hint}>문맥 없음</span>
                )}
              </span>
              <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {/* 부정·헷지 문맥 — 승격 위험의 핵심 신호라 붉게 */}
                {r.negation && (
                  <span className={`${a.chip} ${a.chipWarn}`}>부정 {r.negation}</span>
                )}
                {r.verdict && <span className={a.chip}>{VERDICT_LABEL[r.verdict] ?? r.verdict}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
