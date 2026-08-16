"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import styles from "../../researcher/researcher.module.css";
import q from "./disputes.module.css";

// 이의 확정 — **기각도 반드시 근거를 적는다.**
//
// 접수만 되고 답이 없으면 그 사람의 다음 행선지는 카드사이고, 이 창구를 만든 이유가
// 정확히 그것을 막는 것이다. 그래서 판단 근거가 비면 보내지 않는다 — 이 글은
// 그대로 구매자에게 가는 알림 본문이 된다.

export function ResolveForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<"UPHELD" | "REJECTED">("REJECTED");
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 인정에 2인 승인이 걸려 첫 확정은 "승인 요청 올림"으로 끝난다 — 그건 실패가 아니라
  // 절차의 절반이므로 오류 색으로 보여주면 안 된다
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(retried = false) {
    if (resolution.trim().length < 5) {
      setError("판단 근거를 적어주세요 — 이 글이 그대로 구매자에게 갑니다.");
      return;
    }
    if (!retried) {
      const question =
        verdict === "UPHELD"
          ? "오류로 인정할까요? 두 번째 확인(다른 운영자 승인 또는 지문·얼굴)이 필요하며, 확정되면 구매자에게 통지됩니다. 판정 되돌리기는 별도로 실행해야 합니다."
          : "판정 유지로 확정할까요? 구매자에게 통지되고 이 건의 정산이 다시 열립니다.";
      if (!window.confirm(question)) return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/disputes", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ disputeId, verdict, resolution: resolution.trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "APPROVAL_PENDING") {
          setNotice(json.error);
        } else if (json.code === "RECHECK_REQUIRED" && !retried) {
          // 1인 운영 모드 — 두 번째 사람 대신 지문·얼굴이 선다. 확인되면 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok) {
            await submit(true);
            return;
          }
          if (recheck.error) setError(recheck.error);
        } else {
          setError(json.error ?? "확정 실패");
        }
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={q.resolve}>
      <div className={q.verdicts}>
        {(["REJECTED", "UPHELD"] as const).map((v) => (
          <label key={v} className={verdict === v ? q.verdictOn : q.verdict}>
            <input
              type="radio"
              name={`verdict-${disputeId}`}
              checked={verdict === v}
              onChange={() => setVerdict(v)}
            />
            {v === "REJECTED" ? "판정 유지" : "오류 인정"}
          </label>
        ))}
      </div>
      <textarea
        className={styles.textarea}
        value={resolution}
        onChange={(e) => setResolution(e.target.value)}
        maxLength={500}
        rows={3}
        placeholder={
          verdict === "UPHELD"
            ? "무엇이 어떻게 틀렸는지 (예: 공급자가 8/1 종가를 120원으로 줬으나 실제는 95원)"
            : "확인한 내용 (예: 8월 1일 종가는 120원으로 확인됩니다)"
        }
      />
      <div className={styles.formActions}>
        <button className={styles.primaryBtn} onClick={() => submit()} disabled={busy}>
          {busy ? "보내는 중…" : "확정하고 구매자에게 통지"}
        </button>
      </div>
      {verdict === "UPHELD" && (
        <p className={styles.sub}>
          인정은 <strong>판정을 뒤집는 결정이라 다른 운영자의 승인이 필요합니다</strong> —
          첫 확정은 승인 요청을 올리고, 승인되면 다시 확정하세요. 인정해도 판정이
          자동으로 되돌아가지는 않습니다(별도 절차). 확정 후 아래 목록에 명령이 뜹니다.
        </p>
      )}
      {notice && <p className={styles.sub}>{notice}</p>}
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
