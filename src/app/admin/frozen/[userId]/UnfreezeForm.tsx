"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../../operatorRecheck";
import a from "../../admin.module.css";

// 동결 해제 — 확인한 내용을 적어야 실행되고, 그 글이 그대로 승인자의 사유가 된다.
// 첫 실행은 승인 요청으로 멈추는 것이 정상 흐름이다(2인 승인) — 오류 색으로 그리지 않는다.
//
// **목록이 아니라 상세에서만 푼다** (시안 v3): 목록에서 바로 풀 수 있으면 "누가 얼마나"만
// 보고 푸는 일이 생긴다. 풀지 말지는 그때 무슨 일이 있었는지를 보고 정하는 것이고,
// 그 재료는 이 화면에만 있다.

export function UnfreezeForm({ researcherUserId }: { researcherUserId: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const ready = reason.trim().length > 0;

  async function unfreeze(recheckToken?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/frozen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ researcherUserId, reason: reason.trim(), recheckToken }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "APPROVAL_PENDING") {
          setNotice(json.error);
        } else if (json.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 1인 운영 모드 — 두 번째 사람 대신 지문·얼굴이 선다. 받은 표를 실어 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await unfreeze(recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
        } else {
          setError(json.error ?? "해제에 실패했습니다");
        }
        return;
      }
      setDone(true);
      router.refresh();
      router.push("/admin/frozen");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={a.lbl}>
        무엇으로 본인을 확인했는지
        <small>이 글이 그대로 승인자가 볼 사유가 됩니다</small>
      </div>
      <div className={a.field}>
        <textarea
          className={a.textarea}
          rows={2}
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="예: 8/17 14:00 유선 통화로 본인 확인, 계좌 재등록 안내함"
          aria-label="본인 확인 내용"
        />
      </div>

      <div className={a.sent}>
        <div className={a.sTag}>승인자에게 갈 사유</div>
        <div className={`${a.sV} ${ready ? "" : a.sVNone}`}>
          {reason.trim() || "확인한 내용을 적으면 여기 그대로 나타납니다"}
        </div>
      </div>

      {/* 잉크 = 지금 누를 수 있다. 🔒 = 이 사람의 돈이 다시 나가기 시작한다 */}
      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${ready && !busy && !done ? a.btnInk : a.btnLine}`}
          onClick={() => unfreeze()}
          disabled={!ready || busy || done}
        >
          {busy ? "실행 중…" : done ? "해제됨" : "동결 해제"}
          <span className={a.fp}>🔒</span>
        </button>
      </div>
      {!ready && <div className={a.gate}>확인한 내용을 적어야 해제할 수 있습니다</div>}

      <p className={a.hint}>
        해제에는 <strong>다른 운영자의 승인</strong>이 필요합니다 — 첫 실행은 승인 요청을
        올리고, 승인되면 여기서 다시 실행하세요. 해제는 감사 기록에 남습니다.
      </p>
      {notice && <p className={a.hint}>{notice}</p>}
      {error && <p className={a.error}>{error}</p>}
    </>
  );
}
