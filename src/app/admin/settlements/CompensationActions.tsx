"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import a from "../admin.module.css";

// 플랫폼 귀책 보상의 두 동작. 확정과 실행을 한 버튼으로 합치지 않는다 —
// 확정은 "우리 탓인가"라는 **판단**이고 실행은 은행 이체 뒤의 **기록**이라,
// 합치면 이체도 안 했는데 실행된 것으로 기록하는 길이 생긴다.
//
// 시안 v3의 갈래 문법 (2026-08-19): 예전에는 `대상 아님`과 `보상 승인`이 **동시에
// 살아 있었다.** 결과가 정반대인 두 버튼이 같은 얼굴로 나란히 있으면 어느 쪽을
// 누르기로 했는지가 화면에 없고, 여기서 잘못 누르면 플랫폼 자본이 나가거나
// 정당한 리서처가 대금을 잃는다. 고른 쪽만 잉크로 살리고 반대쪽은 회색이 된다.

/** 귀책 확정 — 보상(APPROVE) 또는 대상 제외(EXCLUDE, 사유 필수). 확정 직전 지문 확인 */
export function CompensationReview({ predictionCardId }: { predictionCardId: string }) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<"APPROVE" | "EXCLUDE" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approving = verdict === "APPROVE";
  const excluding = verdict === "EXCLUDE";
  // 제외는 사유가 필수다 — "우리 탓이 아니다"는 주장이라 근거가 없으면 기록이 안 된다
  const ready = verdict !== null && (approving || note.trim().length > 0);
  const missing = !verdict
    ? "우리 귀책인지 종목 사정인지 먼저 골라 주세요"
    : excluding && !note.trim()
      ? "제외하려면 사유를 적어야 합니다 — 리서처가 대금을 잃는 쪽입니다"
      : "";

  async function decide(decision: "APPROVE" | "EXCLUDE", recheckToken?: string) {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compensations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "REVIEW",
          predictionCardId,
          decision,
          note: note.trim() || undefined,
          ...(recheckToken ? { recheckToken } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 확정에도 지문이 선다 — 실행에만 걸면 훔친 세션이 승인만 눌러 두는
          // "잠복 승인"이 남는다 (1인 모드에서는 확정자와 실행자가 같은 계정이라
          // 이체 대기 목록이 낯선 승인을 걸러 주지 못한다)
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await decide(decision, recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
          return;
        }
        setError(body.error ?? "확정 실패");
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
    <div className={a.form}>
      {/* ── 갈래 ─────────────────────────────────────────────── */}
      <div className={a.chips}>
        <button
          type="button"
          className={`${a.pick} ${excluding ? a.pickOn : ""}`}
          onClick={() => setVerdict(excluding ? null : "EXCLUDE")}
        >
          종목 사정이다 (대상 아님)
        </button>
        <button
          type="button"
          className={`${a.pick} ${approving ? a.pickOn : ""}`}
          onClick={() => setVerdict(approving ? null : "APPROVE")}
        >
          우리 귀책이다 (보상)
        </button>
      </div>

      <div className={a.lbl}>
        확인한 내용
        <small>제외에는 필수 — 리서처가 대금을 잃는 쪽이라 근거가 남아야 합니다</small>
      </div>
      <div className={a.field}>
        <input
          className={a.input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="예: 거래소 공지 확인 — 그날 거래정지 없었음 (우리 피드 장애)"
          aria-label="확인한 내용"
        />
      </div>

      <div className={a.sent}>
        <div className={a.sTag}>기록될 근거</div>
        <div className={`${a.sV} ${note.trim() ? "" : a.sVNone}`}>
          {note.trim() || "적으면 여기 그대로 나타납니다"}
        </div>
      </div>

      {approving && (
        <div className={`${a.note} ${a.noteNeg}`}>
          승인하면 <b>플랫폼 자본</b>에서 판매 대금 − 수수료가 나갑니다 — 확정은 판단이고
          실제 이체는 아래 실행 단계에서 따로 기록합니다.
        </div>
      )}

      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${excluding && ready && !busy ? a.btnInk : a.btnLine} ${
            approving ? a.blocked : ""
          }`}
          disabled={!excluding || !ready || busy}
          onClick={() => decide("EXCLUDE")}
        >
          {busy && excluding ? "확정 중…" : "대상 아님으로 확정"}
        </button>
        <button
          type="button"
          className={`${a.btn} ${approving && ready && !busy ? a.btnInk : a.btnLine} ${
            excluding ? a.blocked : ""
          }`}
          disabled={!approving || !ready || busy}
          onClick={() => decide("APPROVE")}
        >
          {busy && approving ? "확정 중…" : "우리 귀책 — 보상 승인"}
          <span className={a.fp}>🔒</span>
        </button>
      </div>

      {missing && <div className={a.gate}>{missing}</div>}
      {error && <p className={a.error}>{error}</p>}
    </div>
  );
}

/** 보상 실행 기록 — 은행 이체를 먼저 하고, 참조번호로 닫는다. 실행 직전 지문 확인 */
export function CompensationExecute({ compensationId }: { compensationId: string }) {
  const router = useRouter();
  const [bankReference, setBankReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(recheckToken?: string) {
    if (!bankReference.trim()) {
      setError("은행 이체 참조번호를 입력해주세요 — 이체를 먼저 실행하고 그 번호가 유일한 증명입니다.");
      return;
    }
    if (
      !recheckToken &&
      !window.confirm("이 보상을 실행 완료로 기록할까요? 은행에서 실제로 보낸 것이 맞는지 먼저 확인해주세요.")
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compensations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "EXECUTE",
          compensationId,
          bankReference: bankReference.trim(),
          ...(recheckToken ? { recheckToken } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 플랫폼 자본이 나가는 길 — 금액과 무관하게 지문이 선다 (연 몇 건이라
          // 경보 피로가 없고, 이 한 점을 지나야 복구 뒤 48시간 정지도 여기까지 덮는다)
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await post(recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
          return;
        }
        setError(body.error ?? "실행 실패");
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ref = bankReference.trim();
  return (
    <div className={a.form}>
      <div className={a.lbl}>
        은행 이체 참조번호
        <small>이체를 먼저 하고 그 번호를 적습니다 — 이 번호가 유일한 증명입니다</small>
      </div>
      <div className={a.field}>
        <input
          className={a.input}
          value={bankReference}
          onChange={(e) => setBankReference(e.target.value)}
          placeholder="예: 20260819-KB-0031"
          aria-label="은행 이체 참조번호"
        />
      </div>
      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${ref && !busy ? a.btnInk : a.btnLine}`}
          onClick={() => post()}
          disabled={busy || !ref}
        >
          {busy ? "기록 중…" : "보상 실행 완료"}
          <span className={a.fp}>🔒</span>
        </button>
      </div>
      {!ref && <div className={a.gate}>참조번호를 적어야 실행으로 기록할 수 있습니다</div>}
      {error && <p className={a.error}>{error}</p>}
    </div>
  );
}
