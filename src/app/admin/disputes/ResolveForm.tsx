"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import a from "../admin.module.css";

// 이의 확정 — **기각도 반드시 근거를 적는다.**
//
// 접수만 되고 답이 없으면 그 사람의 다음 행선지는 카드사이고, 이 창구를 만든 이유가
// 정확히 그것을 막는 것이다. 그래서 판단 근거가 비면 보내지 않는다 — 이 글은
// 그대로 구매자에게 가는 알림 본문이 된다.
//
// 시안 v3의 갈래 문법 (2026-08-19):
//   · 두 결말을 나란히, **고른 쪽만 잉크로.** 예전에는 `판정 유지`가 미리 선택돼
//     있었는데, 결과가 정반대인 두 길에서 한쪽을 기본값으로 두면 **아무것도 고르지
//     않은 사람의 손이 그쪽으로 흐른다.** 이 화면은 고르는 것이 일의 전부다
//   · **전달될 사유 미리보기** — 이 글이 그대로 구매자 알림이 되므로, 보내기 전에
//     무엇이 나가는지 같은 화면에서 보여준다
//   · **🔒는 인정에만.** 인정은 판정을 뒤집고 끝에 환불로 돈이 움직인다

export function ResolveForm({ disputeId }: { disputeId: string }) {
  const router = useRouter();
  const [verdict, setVerdict] = useState<"UPHELD" | "REJECTED" | null>(null);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 인정에 2인 승인이 걸려 첫 확정은 "승인 요청 올림"으로 끝난다 — 그건 실패가 아니라
  // 절차의 절반이므로 오류 색으로 보여주면 안 된다
  const [notice, setNotice] = useState<string | null>(null);

  const upholding = verdict === "UPHELD";
  const rejecting = verdict === "REJECTED";
  const ready = verdict !== null && resolution.trim().length >= 5;
  const missing = !verdict
    ? "판정을 유지할지 오류로 인정할지 먼저 골라 주세요"
    : resolution.trim().length < 5
      ? "판단 근거를 적어야 합니다 — 이 글이 그대로 구매자에게 갑니다"
      : "";

  async function submit(recheckToken?: string) {
    if (!ready || !verdict) return;
    if (!recheckToken) {
      const question = upholding
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
        body: JSON.stringify({ disputeId, verdict, resolution: resolution.trim(), recheckToken }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "APPROVAL_PENDING") {
          setNotice(json.error);
        } else if (json.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 1인 운영 모드 — 두 번째 사람 대신 지문·얼굴이 선다. 받은 표를 실어 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await submit(recheck.token);
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
    <>
      {/* ── 갈래 ─────────────────────────────────────────────── */}
      <div className={a.chips} style={{ marginTop: 12 }}>
        <button
          type="button"
          className={`${a.pick} ${rejecting ? a.pickOn : ""}`}
          onClick={() => setVerdict(rejecting ? null : "REJECTED")}
        >
          판정이 맞다 (기각)
        </button>
        <button
          type="button"
          className={`${a.pick} ${upholding ? a.pickOn : ""}`}
          onClick={() => setVerdict(upholding ? null : "UPHELD")}
        >
          우리가 틀렸다 (인정)
        </button>
      </div>

      <div className={a.field}>
        <textarea
          className={a.textarea}
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder={
            upholding
              ? "무엇이 어떻게 틀렸는지 (예: 공급자가 8/1 종가를 120원으로 줬으나 실제는 95원)"
              : rejecting
                ? "확인한 내용 (예: 8월 1일 종가는 120원으로 확인됩니다)"
                : "먼저 위에서 판단을 골라 주세요"
          }
          aria-label="판단 근거"
        />
      </div>

      {/* 나가기 전에 무엇이 나가는지 — 이 글은 구매자 알림 본문이 된다 */}
      <div className={a.sent}>
        <div className={a.sTag}>구매자에게 갈 글</div>
        <div className={`${a.sV} ${resolution.trim() ? "" : a.sVNone}`}>
          {resolution.trim() || "근거를 적으면 여기 그대로 나타납니다"}
        </div>
      </div>

      {upholding && (
        <div className={`${a.note} ${a.noteNeg}`}>
          인정은 <b>판정을 뒤집는 결정이라 두 번째 확인이 필요합니다</b> — 첫 확정은 승인
          요청을 올리고 멈춥니다(1인 운영 모드에서는 지문·얼굴이 그 자리를 대신합니다).
          인정해도 판정이 <b>자동으로 되돌아가지는 않습니다</b> — 확정 후 아래 목록에
          되돌리기 명령이 뜹니다.
        </div>
      )}

      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${rejecting && ready && !busy ? a.btnInk : a.btnLine} ${
            upholding ? a.blocked : ""
          }`}
          disabled={!rejecting || !ready || busy}
          onClick={() => submit()}
        >
          {busy && rejecting ? "보내는 중…" : "판정 유지 · 구매자 통지"}
        </button>
        <button
          type="button"
          className={`${a.btn} ${upholding && ready && !busy ? a.btnInk : a.btnLine} ${
            rejecting ? a.blocked : ""
          }`}
          disabled={!upholding || !ready || busy}
          onClick={() => submit()}
        >
          {busy && upholding ? "보내는 중…" : "오류 인정"}
          <span className={a.fp}>🔒</span>
        </button>
      </div>

      {missing && <div className={a.gate}>{missing}</div>}
      {notice && <p className={a.hint}>{notice}</p>}
      {error && <p className={a.error}>{error}</p>}
    </>
  );
}
