"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import a from "../admin.module.css";

// 지시서 실행 버튼: 환불은 방법(PG 취소/계좌이체)을 골라 실행, 지급은 바로 실행.
// 실행은 되돌릴 수 없으므로 confirm 한 번을 거친다.
//
// **끝나지 않은 시도(stuckAttempt)가 있으면 "새로 실행"을 아예 내보내지 않는다.**
// PENDING은 "돈이 나갔는지 우리가 모른다"는 뜻이라, 새로 실행하면 새 키로 한 번 더 나가
// 두 번 빠질 수 있다. 다만 **이어받는 방법이 수단마다 다르다**:
//
//  · PG 취소 → **재시도.** 멱등키가 있어 같은 키로 다시 보내면 결과는 한 번이다
//  · 계좌이체 → **상태 확정.** 사람이 은행 앱에서 보낸 돈에는 멱등키가 없다. 여기서
//    "재시도"를 내보내면 운영자가 "안 나갔구나" 하고 한 번 더 보낼 수 있고 그게 곧
//    이중 송금이다. 그래서 물어보는 것은 하나뿐이다 — **실제로 보내셨습니까**
//
// 시안 v3 (2026-08-19) — 두 곳을 갈래로 폈다:
//  ① **환불 수단**이 드롭다운이었다. PG 취소와 계좌이체는 되돌릴 수 있는 정도가
//     완전히 다른데(전자는 멱등, 후자는 이중 송금 위험) 접힌 목록은 그 차이를 감춘다
//  ② **이체했는가 / 안 했는가**는 이 화면에서 가장 위험한 선택인데 두 버튼이 동시에
//     살아 있었다. 고른 쪽만 잉크로 살리고 반대쪽을 회색으로 눕힌다
export function ExecuteButton({
  kind,
  settlementId,
  stuckAttemptId,
  stuckAttemptMethod,
}: {
  kind: "REFUND" | "PAYOUT";
  settlementId: string;
  stuckAttemptId?: string;
  stuckAttemptMethod?: string;
}) {
  const router = useRouter();
  const [method, setMethod] = useState("PG_CANCEL");
  const [bankReference, setBankReference] = useState("");
  // 멈춘 계좌이체를 어느 쪽으로 닫을지 — 고르기 전에는 아무 버튼도 열리지 않는다
  const [sentChoice, setSentChoice] = useState<"SENT" | "NOT_SENT" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stuck = kind === "REFUND" && !!stuckAttemptId;
  const resolving = stuck && stuckAttemptMethod === "BANK_TRANSFER";
  const retrying = stuck && !resolving;
  const ref = bankReference.trim();
  // 새 계좌이체 실행이거나, 멈춘 계좌이체를 "보냈다"로 닫을 때 참조번호가 필요하다
  const needsReference =
    (resolving && sentChoice === "SENT") ||
    (kind === "REFUND" && !stuck && method === "BANK_TRANSFER");

  async function post(body: Record<string, unknown>, question: string, recheckToken?: string) {
    if (!recheckToken && !window.confirm(question)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settlements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(recheckToken ? { ...body, recheckToken } : body),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 1인 운영 모드의 고액 지급 — 지문 1초가 흐름을 끊는 물리적 브레이크다
          // (검토 6차 Q2). 받은 표를 실어 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await post(body, question, recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
          return;
        }
        setError(json.error ?? "실행 실패");
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function execute() {
    const label = kind === "REFUND" ? "환불" : "지급";
    if (retrying) {
      return post(
        { kind: "REFUND_RETRY", attemptId: stuckAttemptId },
        "끝나지 않은 PG 취소를 같은 키로 다시 보낼까요? 이미 나갔다면 중복되지 않습니다.",
      );
    }
    if (resolving) {
      if (sentChoice === "NOT_SENT") {
        return post(
          { kind: "REFUND_RESOLVE", attemptId: stuckAttemptId, resolution: "NOT_SENT" },
          "이체하지 않은 것으로 확정할까요? 이 건은 다시 환불 실행 대상이 됩니다.",
        );
      }
      return post(
        {
          kind: "REFUND_RESOLVE",
          attemptId: stuckAttemptId,
          resolution: "SENT",
          bankReference: ref,
        },
        "이 이체를 완료로 확정할까요? 은행 앱에서 실제로 보낸 것이 맞는지 먼저 확인해주세요.",
      );
    }
    return post(
      kind === "REFUND"
        ? { kind, settlementId, method, ...(needsReference ? { bankReference: ref } : {}) }
        : { kind, settlementId },
      `${label}을 실행 완료로 기록할까요? 되돌릴 수 없습니다.`,
    );
  }

  const ready = resolving
    ? sentChoice === "NOT_SENT" || (sentChoice === "SENT" && ref !== "")
    : !needsReference || ref !== "";
  const missing = resolving
    ? !sentChoice
      ? "은행 앱에서 확인한 뒤 보냈는지 아닌지 골라 주세요"
      : sentChoice === "SENT" && !ref
        ? "참조번호를 적어야 완료로 닫을 수 있습니다"
        : ""
    : needsReference && !ref
      ? "계좌이체는 참조번호가 있어야 실행됩니다 — 중복 송금을 시스템이 막을 수 없습니다"
      : "";

  return (
    <div className={a.form}>
      {/* ── 환불 수단 ─────────────────────────────────────────── */}
      {kind === "REFUND" && !stuck && (
        <div className={a.chips}>
          <button
            type="button"
            className={`${a.pick} ${method === "PG_CANCEL" ? a.pickOn : ""}`}
            onClick={() => setMethod("PG_CANCEL")}
          >
            PG 결제 취소
          </button>
          <button
            type="button"
            className={`${a.pick} ${method === "BANK_TRANSFER" ? a.pickOn : ""}`}
            onClick={() => setMethod("BANK_TRANSFER")}
          >
            계좌이체 (취소 기한 초과)
          </button>
        </div>
      )}

      {/* ── 멈춘 계좌이체: 보냈는가 ───────────────────────────── */}
      {resolving && (
        <>
          <div className={a.lbl}>
            은행 앱에서 확인한 결과
            <small>재시도가 곧 이중 송금이라, 여기서 물어보는 것은 이것 하나뿐입니다</small>
          </div>
          <div className={a.chips}>
            <button
              type="button"
              className={`${a.pick} ${sentChoice === "NOT_SENT" ? a.pickOn : ""}`}
              onClick={() => setSentChoice(sentChoice === "NOT_SENT" ? null : "NOT_SENT")}
            >
              보내지 않았다
            </button>
            <button
              type="button"
              className={`${a.pick} ${sentChoice === "SENT" ? a.pickOn : ""}`}
              onClick={() => setSentChoice(sentChoice === "SENT" ? null : "SENT")}
            >
              실제로 보냈다
            </button>
          </div>
        </>
      )}

      {/* 계좌이체에는 멱등키가 없다 — 은행에서 이미 보낸 이체를 시스템이 알 방법이
          이 번호뿐이고, 입력을 요구하는 것 자체가 운영자를 은행 앱으로 되돌려 보낸다 */}
      {needsReference && (
        <div className={a.field}>
          <input
            className={a.input}
            value={bankReference}
            onChange={(e) => setBankReference(e.target.value)}
            placeholder="은행 이체 참조번호 — 예: 20260819-KB-0031"
            aria-label="은행 이체 참조번호"
          />
        </div>
      )}

      {/* ── 실행 ──────────────────────────────────────────────── */}
      <div className={a.btnrow}>
        {resolving ? (
          <>
            <button
              type="button"
              className={`${a.btn} ${
                sentChoice === "NOT_SENT" && !busy ? a.btnInk : a.btnLine
              } ${sentChoice === "SENT" ? a.blocked : ""}`}
              disabled={sentChoice !== "NOT_SENT" || busy}
              onClick={execute}
            >
              {busy && sentChoice === "NOT_SENT" ? "기록 중…" : "보내지 않았음 — 다시 대상으로"}
            </button>
            <button
              type="button"
              className={`${a.btn} ${sentChoice === "SENT" && ready && !busy ? a.btnInk : a.btnLine} ${
                sentChoice === "NOT_SENT" ? a.blocked : ""
              }`}
              disabled={sentChoice !== "SENT" || !ready || busy}
              onClick={execute}
            >
              {busy && sentChoice === "SENT" ? "기록 중…" : "이체 완료로 확정"}
              <span className={a.fp}>🔒</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            className={`${a.btn} ${ready && !busy ? a.btnInk : a.btnLine}`}
            disabled={!ready || busy}
            onClick={execute}
          >
            {busy
              ? "기록 중…"
              : retrying
                ? "미완료 PG 취소 재시도"
                : kind === "REFUND"
                  ? "환불 실행 완료"
                  : "지급 실행 완료"}
            {/* 재시도는 같은 멱등키를 이어받는 것이라 새 돈이 아니다 — 자물쇠를 달지 않는다 */}
            {!retrying && <span className={a.fp}>🔒</span>}
          </button>
        )}
      </div>

      {missing && <div className={a.gate}>{missing}</div>}
      {retrying && (
        <p className={a.hint}>
          앞선 시도의 PG 응답을 받지 못했습니다. 같은 키로 다시 보내므로 이미 나갔다면
          중복되지 않습니다.
        </p>
      )}
      {resolving && (
        <p className={a.hint}>
          계좌이체는 자동 재시도할 수 없습니다(멱등키가 없어 재시도가 곧 이중 송금입니다).
          <strong> 은행 앱에서 이체 여부를 먼저 확인</strong>한 뒤 상태를 골라주세요.
        </p>
      )}
      {error && <p className={a.error}>{error}</p>}
    </div>
  );
}
