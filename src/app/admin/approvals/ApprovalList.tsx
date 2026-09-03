"use client";

import { useState } from "react";
import type { ApprovalAction } from "@/domain/operatorApproval";
import a from "../admin.module.css";

type Approval = {
  id: string;
  action: string;
  summary: string;
  amountKrw: number | null;
  requestedBy: string;
  requestedAt: string;
  reason: string;
  /** 내가 올린 요청인가 — 요청자는 자기 요청을 승인할 수 없다 (서버가 거절한다) */
  mine: boolean;
  /** 만료까지 남은 시간(시). 0 이하면 곧 사라진다 */
  hoursLeft: number;
};

// 승인 대기열 — **승인자가 무엇을 승인하는지 알아야 승인이 의미를 갖는다.**
//
// 요약·사유·금액·요청자를 다 보여준다. "승인" 버튼만 있는 화면은 누르는 습관을
// 만들고, 습관이 된 승인은 2인 승인이 아니라 클릭 두 번일 뿐이다.
//
// 그래서 시안 v3의 **갈래 문법**을 그대로 쓴다 (2026-08-19):
//   · 두 결말을 나란히 펴 두고 **고른 쪽만 잉크로 살린다** — 반대쪽은 회색이 된다.
//     결과가 정반대인 두 버튼이 같은 얼굴로 서 있으면 어느 쪽을 누르기로 했는지가
//     화면에 없다
//   · **근거를 적어야 열린다.** API는 note를 선택으로 받지만 화면은 요구한다 —
//     습관 클릭을 막는 가장 강한 장치가 "한 문장을 쓰게 하는 것"이고, 그 글이
//     나중에 "왜 승인했나"에 답하는 유일한 기록이다
//   · **🔒는 승인에만.** 승인은 돈이 실제로 움직이는 문을 여는 쪽이다

// **이 표가 비면 승인 화면이 영어 열거값을 그린다** — 그러면 승인자는 무엇을
// 승인하는지 모른 채 누르게 되고, 위의 장치(근거 강제·갈래 문법)가 전부 헛돈다.
// 새 ApprovalAction 을 만들면 여기 두 줄을 같이 채운다 — **`Record<ApprovalAction, …>`
// 라 안 채우면 컴파일이 막는다.** 격리(REGRESSION_CASE_QUARANTINE)가 6개월간 비어
// 있었던 이유가 정확히 이 타입이 `Record<string, …>` 였기 때문이다: 빠뜨려도 아무도
// 말해 주지 않고, 화면에서 열거값 원문이 뜨는 것을 눈으로 보기 전에는 알 수 없다.
const ACTION_LABEL: Record<ApprovalAction, string> = {
  PAYOUT_UNFREEZE: "정산 동결 해제",
  LARGE_PAYOUT: "고액 지급 실행",
  DISPUTE_UPHOLD: "판정 이의 인정 (판정 뒤집기)",
  FIRST_MANUAL_JUDGMENT: "기계 판정 없는 수동 판정",
  REGRESSION_CASE_QUARANTINE: "회귀 시험 문항 격리",
};

/** 승인하면 무엇이 일어나는가 — 요약만으로는 결과가 안 보인다 */
const ACTION_EFFECT: Record<ApprovalAction, string> = {
  PAYOUT_UNFREEZE: "이 사람의 정산이 다시 열립니다 — 동결은 본인이 걸고 운영자만 풉니다",
  LARGE_PAYOUT: "승인서 1장이 나가고, 그 표로 지급이 한 번 실행됩니다",
  DISPUTE_UPHOLD: "판정을 뒤집는 확정이 열립니다 — 되돌리기는 별도 명령입니다",
  FIRST_MANUAL_JUDGMENT: "운영자가 넣은 숫자가 그대로 원천 데이터가 됩니다",
  // **되돌릴 수 없다는 것이 이 승인의 핵심 사실이다** (회신 3호 B-2 — 격리 해제 함수는
  // 없고 만들 계획도 없다. 되돌릴 수 있으면 "일단 빼고 릴리스, 나중에 복구"라는
  // 우회로가 생긴다). "문항 수정은 없습니다"는 격리와 무관한 별개 원칙이라 섞지 않는다 —
  // 섞으면 격리가 수정의 대체재로 읽힌다
  REGRESSION_CASE_QUARANTINE:
    "이 문항이 회귀 시험셋에서 영구히 빠집니다. 되돌릴 수 없습니다. 다음 재학습부터 이 문항으로는 ARGOS를 시험하지 않습니다",
};

// **좁히는 자리를 한 곳으로 모은다** — 행의 action 은 DB에서 온 문자열이라 열거값이라는
// 보장이 없다. 세 자리에서 각자 캐스팅하면 폴백 문구도 세 벌이 되고, 언젠가 한 곳만
// 어긋난다(승인 카드와 확인창이 다른 말을 하는 것이 이 화면에서 가장 나쁜 고장이다)
const actionLabel = (action: string) => ACTION_LABEL[action as ApprovalAction] ?? action;
const actionEffect = (action: string) =>
  ACTION_EFFECT[action as ApprovalAction] ?? "실행이 열립니다";

export function ApprovalList({ initial }: { initial: Approval[] }) {
  const [items, setItems] = useState(initial);

  if (items.length === 0) {
    return <div className={a.empty}>대기 중인 승인 요청이 없습니다.</div>;
  }

  return (
    <div className={a.list}>
      {items.map((it) => (
        <ApprovalCard
          key={it.id}
          item={it}
          onDone={() => setItems((prev) => prev.filter((i) => i.id !== it.id))}
        />
      ))}
    </div>
  );
}

function ApprovalCard({ item, onDone }: { item: Approval; onDone: () => void }) {
  const [decision, setDecision] = useState<"APPROVE" | "REJECT" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approving = decision === "APPROVE";
  const rejecting = decision === "REJECT";
  const ready = !item.mine && decision !== null && note.trim().length > 0;
  // 닫힌 쪽은 회색이 이미 말하고 있다 — **덜 채운 쪽만** 말한다
  const missing = item.mine
    ? "내가 올린 요청이라 내가 승인할 수 없습니다 — 그 비대칭이 2인 승인의 전부입니다"
    : !decision
      ? "승인인지 반려인지 먼저 골라 주세요"
      : !note.trim()
        ? "근거를 적어야 합니다 — 나중에 '왜 승인했나'에 답하는 유일한 기록입니다"
        : "";

  async function submit() {
    if (!ready || !decision) return;
    if (
      approving &&
      !window.confirm(`승인합니다 — ${actionEffect(item.action)}. 진행할까요?`)
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approvalId: item.id, approve: approving, note: note.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "처리에 실패했습니다");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  // 만료가 가까운 것이 붉다 — 사라지면 기안자가 **사유부터 다시 써야** 한다
  const urgent = item.hoursLeft <= 24;

  return (
    <div className={`${a.card} ${urgent ? a.stripeNeg : a.stripeWarn}`}>
      <div className={a.row}>
        <span className={a.ttl}>{item.summary}</span>
        {item.amountKrw != null && (
          <span className={a.metricValue}>{item.amountKrw.toLocaleString()}원</span>
        )}
      </div>

      <div className={a.meta}>
        <span className={`${a.chip} ${a.chipWarn}`}>{actionLabel(item.action)}</span>
        <span>요청 {new Date(item.requestedAt).toLocaleString("ko-KR")}</span>
        <span>{item.requestedBy}</span>
        <span className={`${a.chip} ${urgent ? a.chipNeg : ""}`}>
          {item.hoursLeft <= 0 ? "곧 만료" : `만료까지 ${Math.floor(item.hoursLeft)}시간`}
        </span>
      </div>

      {/* 기안자가 쓴 글 그대로 — 요약하면 판단의 재료가 사라진다 */}
      <div className={a.lbl}>요청 사유</div>
      <div className={a.quote}>{item.reason}</div>

      <div className={a.note}>승인하면 — {actionEffect(item.action)}</div>

      {/* ── 갈래 ─────────────────────────────────────────────── */}
      {!item.mine && (
        <>
          <div className={a.chips} style={{ marginTop: 12 }}>
            <button
              type="button"
              className={`${a.pick} ${rejecting ? a.pickOn : ""}`}
              onClick={() => setDecision(rejecting ? null : "REJECT")}
            >
              반려한다
            </button>
            <button
              type="button"
              className={`${a.pick} ${approving ? a.pickOn : ""}`}
              onClick={() => setDecision(approving ? null : "APPROVE")}
            >
              승인한다
            </button>
          </div>

          <div className={a.field}>
            <input
              className={a.input}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                approving
                  ? "확인한 내용 — 예: 본인 확인 통화 완료, 계좌 뒤 4자리 일치"
                  : rejecting
                    ? "반려 사유 — 예: 본인 확인 경로가 앱 안이라 근거가 안 됨"
                    : "먼저 위에서 판단을 골라 주세요"
              }
              aria-label="판단 근거"
              maxLength={300}
            />
          </div>

          {/* 나가기 전에 무엇이 남는지 — 이 글이 감사 기록의 전부다 */}
          <div className={a.sent}>
            <div className={a.sTag}>감사 기록에 남을 근거</div>
            <div className={`${a.sV} ${note.trim() ? "" : a.sVNone}`}>
              {note.trim() || "적으면 여기 그대로 나타납니다"}
            </div>
          </div>
        </>
      )}

      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${rejecting && ready && !busy ? a.btnInk : a.btnLine} ${
            approving ? a.blocked : ""
          }`}
          disabled={!rejecting || !ready || busy}
          onClick={submit}
        >
          {busy && rejecting ? "처리 중…" : "반려"}
        </button>
        <button
          type="button"
          className={`${a.btn} ${approving && ready && !busy ? a.btnInk : a.btnLine} ${
            rejecting ? a.blocked : ""
          }`}
          disabled={!approving || !ready || busy}
          onClick={submit}
        >
          {busy && approving ? "처리 중…" : "승인"}
          <span className={a.fp}>🔒</span>
        </button>
      </div>

      {missing && <div className={a.gate}>{missing}</div>}
      {error && <p className={a.error}>{error}</p>}
    </div>
  );
}
