"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { RejectAuditItem } from "@/server/rejectAuditService";
import { fmtDayMonth as fmtDate } from "@/lib/format";
import a from "../admin.module.css";

// 거절 훑기 (B1, 2026-09-01) — 즉시 거절(BLOCK)은 큐에 안 와 사람 판정이 안 붙는다. 판정 없는
// 거절 기록을 규칙별 최근 5건 표본(+이의 건 전부)으로 띄우고 **정탐/오탐만** 찍는다. 찍는 순간
// 그 기록이 사다리 집계에 들어가 BLOCK 규칙의 오탐이 처음으로 잡힌다.
// **자동 강등은 없다** — 오탐이면 즉시 재학습, 내리는 판단은 창업자 수동. 리포트 상태도 안 건드린다.

export function RejectAuditList({ items }: { items: RejectAuditItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function label(reviewId: string, verdict: "TP" | "FP") {
    setBusy(reviewId);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance/reject-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewId, verdict }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "판정하지 못했습니다");
        return;
      }
      router.refresh();
    } catch {
      setError("서버에 닿지 못했습니다");
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className={a.empty}>
        <span className={a.dot} />
        판정을 기다리는 즉시 거절이 없습니다
      </div>
    );
  }

  return (
    <div>
      {error && <p className={a.error}>{error}</p>}
      {items.map((it) => (
        <div key={it.reviewId} className={`${a.card} ${it.appealAt ? a.stripeWarn : ""}`}>
          <div className={a.row}>
            <span className={a.ttl}>{it.title}</span>
            <span style={{ fontSize: 12, color: "var(--text-faint)" }}>{fmtDate(it.createdAt)}</span>
          </div>
          <div className={a.meta}>
            {it.researcher && <span>{it.researcher}</span>}
            {it.ruleIds.map((r) => (
              <span key={r} className={a.chip}>
                {r}
              </span>
            ))}
            {it.appealAt && <span className={`${a.chip} ${a.chipWarn}`}>이의</span>}
          </div>
          {it.quotes.map((q, i) => (
            <div key={i} className={a.quote}>
              &ldquo;{q}&rdquo;
            </div>
          ))}
          {it.appealStatement && (
            <div className={`${a.note} ${a.noteWarn}`}>
              <b>리서처 소명</b> — {it.appealStatement}
            </div>
          )}
          <div className={a.btnrow}>
            <button
              type="button"
              className={`${a.btn} ${a.btnLine}`}
              disabled={busy === it.reviewId}
              onClick={() => label(it.reviewId, "TP")}
              title="거절이 맞았다 — 사다리에 정탐으로 남습니다"
            >
              정탐 — 거절이 맞았다
            </button>
            <button
              type="button"
              className={`${a.btn} ${a.btnLine}`}
              disabled={busy === it.reviewId}
              onClick={() => label(it.reviewId, "FP")}
              title="잘못 거절했다 — 사다리에 오탐으로 남고, 이의를 낸 리서처에게 알립니다. 규칙을 내리는 판단은 별도(수동)"
              style={{ color: "#bd4242" }}
            >
              오탐 — 잘못 거절했다
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
