"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import a from "../admin.module.css";

// **같은 리포트의 환불을 한 번 눌러 차례로 실행한다** (시안 scr-money).
//
// 원자적 실행이 아니다 — 안에서 PG를 부르므로 트랜잭션으로 묶을 수 없다. 이 버튼이
// 파는 것은 원자성이 아니라 **반쯤 하다 마는 상태가 안 생기는 것**이다: 셋 중 둘만
// 누르고 화면을 뜨는 일이 없어진다.
//
// **PG 취소 전용이다.** 계좌이체는 사람이 은행 앱에서 건별로 보내고 참조번호도 건마다
// 다른데, 한 번호로 여러 건을 닫으면 어느 이체가 실제로 나갔는지 증명이 사라진다.
// 취소 기한이 지난 건은 묶음에 들어오지 못하고 아래 개별 카드로 남는다.
//
// 결과는 삼키지 않는다. 한도·이의·쿨다운으로 막힌 건은 그 건만 멈추고 화면이
// "3건 중 2건 실행"과 막힌 이유를 그대로 적는다 — 삼키면 화면과 장부가 갈린다.
export function RefundGroupButton({
  settlementIds,
  totalKrw,
}: {
  settlementIds: string[];
  totalKrw: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);

  const n = settlementIds.length;

  async function execute() {
    if (
      !window.confirm(
        `${n}건 · 합계 ${totalKrw.toLocaleString()}원을 PG 취소로 차례로 실행할까요? 되돌릴 수 없습니다.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    setFailures([]);
    setDone(null);
    try {
      const res = await fetch("/api/admin/settlements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "REFUND_GROUP", settlementIds, method: "PG_CANCEL" }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "실행 실패");
        return;
      }
      setDone(`${json.total}건 중 ${json.done}건 실행`);
      setFailures(
        (json.results as { ok: boolean; error?: string }[])
          .filter((r) => !r.ok)
          .map((r) => r.error ?? "실행 실패"),
      );
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={a.form}>
      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${busy ? a.btnLine : a.btnInk}`}
          disabled={busy}
          onClick={execute}
        >
          {busy ? `${n}건 실행 중…` : `${n}건 한 번에 실행`}
          <span className={a.fp}>🔒</span>
        </button>
      </div>

      {done && (
        <p className={a.hint} style={{ color: "var(--pos)", fontWeight: 700 }}>
          {done}
        </p>
      )}
      {failures.length > 0 && (
        <div className={`${a.note} ${a.noteNeg}`}>
          막힌 건은 아래 개별 카드에 그대로 남아 있습니다.
        </div>
      )}
      {failures.map((f, i) => (
        <p key={i} className={a.error}>
          {f}
        </p>
      ))}
      {error && <p className={a.error}>{error}</p>}
    </div>
  );
}
