"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RISK_CATEGORIES, RISK_CATEGORY_LABEL, type RiskCategory } from "@/domain/compliance";
import a from "../admin.module.css";
import { PhraseField } from "../PhraseField";
import { TwoPaths } from "../TwoPaths";

// 2단 검수로 결론이 나지 않은 건에 대한 운영자의 최종 결정.
//
// 보류(PENDING_REVIEW) — 아직 판매 전이라 환불 문제가 없다
//   · 게시 승인: 지금 시점 기준가·수수료로 판매 시작
//   · 반려: 초안으로 되돌리고 사유 통지 (리서처가 고쳐서 재제출 가능)
// 게시 중(PUBLISHED) — 승인 후 재검토
//   · 게시 유지 / 강제 철회(전액 환불). 되돌릴 수 없어 사유가 필수다
//
// 이 결정은 동시에 **검수의 정답 라벨**이다 (screeningAccuracy.ts). 승인은 기본적으로
// "오탐"으로, 반려·철회는 "정탐"으로 기록되고, 이 라벨이 없으면 오탐률을 알 수 없어
// 규칙·프롬프트·모델을 근거 있게 바꿀 수 없다.
//
// ── 시안 v3 문법으로 다시 지었다 (2026-08-19) ─────────────────
// 전에는 [승인][반려] 두 버튼이 같은 얼굴로 나란히 있고, 반려를 누르면 화면이 통째로
// 폼으로 바뀌었다. 두 가지가 나빴다: ① 어느 쪽으로 가기로 했는지가 화면에 없다
// ② 폼으로 바뀌는 순간 판단의 재료(소견·인용문)가 사라진다 — 사유를 쓰는 동안
// 무엇을 보고 쓰는지가 없어진다.
//
// 대신 **두 갈래를 나란히 펴 두고 고른 쪽만 살린다**:
//   · 반려 갈래를 건드리면(유형·사유) 승인 갈래가 회색이 되고, 반대도 같다
//   · 누를 수 있는 버튼만 잉크색이 된다 — 흰 버튼 둘은 켜졌는지 안 읽힌다
//   · 되돌릴 수 없는 실행에는 🔒 — **동작의 무게는 색이 아니라 자물쇠가 진다**

export function ResolveButton({
  reviewId,
  reportId,
  reportStatus,
  heldPurchases,
  heldAmountKrw,
  flaggedCategories = [],
  suggestedPhrase = "",
}: {
  /** 검토 큐 항목일 때만 존재 — 판매 중 목록에서 온 건은 없다 */
  reviewId?: string;
  reportId: string;
  reportStatus: string;
  heldPurchases: number;
  heldAmountKrw: number;
  /** 검수가 지적한 유형 — 반려 시 실제 위반 유형의 기본 선택값이 된다 */
  flaggedCategories?: RiskCategory[];
  /** 학습 표현 등록란의 기본값 (검수 인용문 중 가장 짧은 것) */
  suggestedPhrase?: string;
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 승인 라벨은 **세 갈래다** (11차 K-1):
  //   null   아무 표시 없이 승인 (기본) — 정확도 지표에는 오탐, 자동 격하에는 표본 아님
  //   true   지적은 타당했다 (경미해서 통과)
  //   false  **오탐이라고 명시적으로 신고했다**
  //
  // 예전에는 boolean 하나였고 체크 안 하면 false 였다. 그 값이 10차부터 자동 격하의
  // 입력이 되면서, **큐가 밀린 날 빠르게 누른 승인이 모델을 끌어내리는** 경로가 됐다
  // (실측: 25건 중 6건이면 영구 격하). 클릭을 강제하지 않는다는 원칙은 그대로 두고,
  // 대신 "말하지 않았다"와 "틀렸다고 말했다"를 갈랐다.
  const [findingsValid, setFindingsValid] = useState<boolean | null>(null);
  const [categories, setCategories] = useState<RiskCategory[]>(flaggedCategories);
  const [manual, setManual] = useState(false);
  const [phrase, setPhrase] = useState(suggestedPhrase);
  const [warning, setWarning] = useState<string | null>(null);
  /** 등록 직후 한 번만 보여줄 충돌 상대 — 화면을 새로 그리면 사라진다 */
  const [collisions, setCollisions] = useState<string[] | null>(null);

  const pending = reportStatus === "PENDING_REVIEW";
  const takedown = !pending && reportStatus === "PUBLISHED";

  // **사람이 한 행동만 센다.** 검수 소견은 처음부터 들어 있으므로(flaggedCategories)
  // 그걸로 "반려 갈래를 골랐다"고 보면 승인이 영영 회색이 된다
  const touchedReject =
    reason.trim().length > 0 ||
    categories.length !== flaggedCategories.length ||
    categories.some((c) => !flaggedCategories.includes(c));
  const touchedApprove = findingsValid !== null;

  const rejecting = touchedReject;
  const approving = touchedApprove;

  function toggle(c: RiskCategory) {
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  async function post(body: Record<string, unknown>, failMessage: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.issues ? payload.issues.join(" / ") : (payload.error ?? failMessage));
        return;
      }
      // 처리는 성공했는데 표현 등록만 실패한 경우 — 되돌리지 않고 알리기만 한다
      if (payload.phraseWarning) {
        setWarning(payload.phraseWarning);
        return;
      }
      // **등록 직후 딱 한 번** 충돌 상대를 보여준다 (회신 5호 Q1). 입력 중에 보여주면
      // 그것을 피해 표현을 다듬게 되지만, 여기서는 표현이 이미 확정돼 그 고리가 없다.
      // 화면을 새로 그리면 이 정보는 사라진다 — 그래서 갱신을 멈추고 먼저 읽게 한다
      if (payload.phraseCollisions?.length) {
        setCollisions(payload.phraseCollisions);
        return;
      }
      router.refresh();
    } catch {
      setError(failMessage);
    } finally {
      setBusy(false);
    }
  }

  const negLabel = takedown ? "확인 · 강제 철회" : "반려";
  const negMissing = !reason.trim()
    ? `${takedown ? "철회" : "반려"} 사유를 적어야 합니다 — 리서처에게 그대로 갑니다`
    : "";
  const posMissing = "";
  const negLive = !approving && !negMissing && !busy;
  const posLive = !rejecting && !busy;

  return (
    <>
      {/* ── 위반이 맞다면 ─────────────────────────────────────── */}
      <div className={`${a.branch} ${approving ? a.branchOff : ""}`}>
        <div className={a.lbl}>
          위반이 맞다면
          <small>실제 유형 — 검수가 짚은 것과 다를 수 있습니다</small>
        </div>
        <div className={a.chips}>
          {RISK_CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`${a.pick} ${categories.includes(c) ? a.pickOn : ""}`}
              onClick={() => toggle(c)}
            >
              {RISK_CATEGORY_LABEL[c]}
            </button>
          ))}
          <button
            type="button"
            className={`${a.pick} ${a.pickMore} ${manual ? a.pickOn : ""}`}
            onClick={() => setManual((v) => !v)}
          >
            직접 입력 ✎
          </button>
        </div>

        {manual && (
          <PhraseField
            value={phrase}
            onChange={setPhrase}
            category={categories[0]}
            placeholder="사전에 등록 — 예: 반드시 오릅니다"
          />
        )}

        <div className={a.field}>
          <textarea
            className={a.textarea}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder={`${takedown ? "철회" : "반려"} 사유 — 리서처에게 그대로 통지됩니다`}
            aria-label={`${takedown ? "철회" : "반려"} 사유`}
          />
        </div>

        {/* 나가기 전에 무엇이 나가는지 */}
        <div className={a.sent}>
          <div className={a.sTag}>
            전달될 사유 · {reason.trim() ? "직접 입력" : "아직 없음"}
          </div>
          <div className={`${a.sV} ${reason.trim() ? "" : a.sVNone}`}>
            {reason.trim() || "사유를 적으면 여기 그대로 나타납니다"}
          </div>
        </div>

        <TwoPaths
          takedown={takedown}
          phrase={manual ? phrase.trim() : ""}
          categoryCount={categories.length}
        />
      </div>

      {/* ── 위반이 아니라면 ───────────────────────────────────── */}
      <div className={`${a.branch} ${rejecting ? a.branchOff : ""}`}>
        <div className={a.lbl}>위반이 아니라면</div>
        {flaggedCategories.length > 0 ? (
          <>
            {/* 고르지 않아도 승인은 된다 — 클릭을 강제하면 아무렇게나 눌린다.
                다만 고른 것과 안 고른 것이 **다른 뜻**이라는 사실은 화면이 말해야 한다. */}
            <label className={a.check}>
              <input
                type="radio"
                name={`fv-${reportId}`}
                checked={findingsValid === null}
                onChange={() => setFindingsValid(null)}
              />
              표시하지 않고 승인 — 모델 성적에 반영하지 않습니다
            </label>
            <label className={a.check}>
              <input
                type="radio"
                name={`fv-${reportId}`}
                checked={findingsValid === true}
                onChange={() => setFindingsValid(true)}
              />
              지적 자체는 타당했다 (경미해서 통과)
            </label>
            <label className={a.check}>
              <input
                type="radio"
                name={`fv-${reportId}`}
                checked={findingsValid === false}
                onChange={() => setFindingsValid(false)}
              />
              <b>오탐이었다</b> — 이 지적은 부적절했습니다
            </label>
            <p className={a.hint}>
              마지막 항목만 학생 모델의 <b>오탐 표본</b>으로 셉니다. 이 신고가 쌓이면
              모델이 스스로 검수에서 내려갑니다 — 그래서 무심코 누른 승인은 세지 않습니다.
            </p>
          </>
        ) : (
          <p className={a.hint}>인정할 검수 소견이 없습니다 — 그대로 통과시킵니다.</p>
        )}
      </div>

      {/* 되돌릴 수 없는 실행에는 무엇이 일어나는지 먼저 적는다 */}
      {takedown && (
        <div className={`${a.note} ${a.noteNeg}`}>
          확인하면 강제 철회 —{" "}
          {heldPurchases > 0
            ? `구매 ${heldPurchases}건 ${heldAmountKrw.toLocaleString()}원 전액 환불`
            : "환불 대상 없음"}{" "}
          · 수수료 0 · 점수 0. <b>되돌릴 수 없습니다.</b>
        </div>
      )}

      <div className={a.btnrow}>
        <button
          type="button"
          // 콘솔에 "지금 누를 수 있다"의 답은 하나여야 한다 — 잉크다.
          // 민트를 여기 쓰면 승인 쪽만 다른 색이 되어, 화면마다 살아 있는 버튼의
          // 얼굴이 달라진다 (민트는 원래 소비자 화면의 플랫폼 검증 전용 색이다)
          className={`${a.btn} ${posLive ? a.btnInk : a.btnLine} ${rejecting ? a.blocked : ""}`}
          disabled={!posLive}
          onClick={() =>
            pending
              ? post({ action: "APPROVE", reportId, findingsValid }, "승인 실패")
              : post({ action: "RESOLVE", reviewId }, "처리 실패")
          }
        >
          {busy ? "처리 중…" : pending ? "게시 승인" : "게시 유지"}
        </button>
        {(pending || takedown) && (
          <button
            type="button"
            className={`${a.btn} ${negLive ? a.btnInk : a.btnLine} ${approving ? a.blocked : ""}`}
            disabled={!negLive}
            onClick={() =>
              post(
                {
                  action: takedown ? "TAKEDOWN" : "REJECT",
                  reportId,
                  reason,
                  categories,
                  phrase: manual ? phrase : undefined,
                },
                takedown ? "철회 실패" : "반려 실패",
              )
            }
          >
            {busy ? "처리 중…" : negLabel}
            {takedown && <span className={a.fp}>🔒</span>}
          </button>
        )}
      </div>

      {/* 안내는 한 줄만 — 닫힌 쪽은 회색이 이미 말하고 있으므로 **덜 채운 쪽**만 말한다 */}
      {!approving && negMissing && <div className={a.gate}>{negMissing}</div>}
      {approving && posMissing && <div className={a.gate}>{posMissing}</div>}
      {error && <p className={a.error}>{error}</p>}
      {warning && (
        <p className={a.hint} style={{ color: "var(--warn)", fontWeight: 700 }}>
          처리는 완료됐지만 표현은 등록되지 않았습니다: {warning}
        </p>
      )}
      {collisions && <CollisionNotice against={collisions} onClose={() => router.refresh()} />}
    </>
  );
}

/**
 * 왜 근사 표기 감시에서 빠졌는지 — **등록 직후 한 번**.
 *
 * 등록은 성공했다. 다만 이 표현의 한 글자 이웃에 정상 낱말·문장이 있어
 * 근사 매칭을 켜면 그것들까지 잡는다. 그 사실을 말하지 않으면 운영자는
 * 자기 표현이 어디까지 감시받는지 모른 채 목록에서 `근사 표기 제외` 만 보게 된다.
 */
function CollisionNotice({ against, onClose }: { against: string[]; onClose: () => void }) {
  return (
    <div className={`${a.note} ${a.noteWarn}`} style={{ marginTop: 10 }}>
      <b>등록됐습니다 — 다만 근사 표기 감시에서는 빠집니다.</b>
      <br />이 표현을 한 글자 흐트러뜨린 형태가 다음과 정확히 부딪힙니다:{" "}
      <b>{against.map((x) => `“${x}”`).join(" · ")}</b>. 근사 매칭을 켜면 이것들을 쓴 정상
      리포트가 함께 보류됩니다. <b>정확 표기 감시는 그대로 돕니다.</b>
      <div style={{ marginTop: 8 }}>
        <button type="button" className={a.btn} onClick={onClose}>
          확인했습니다
        </button>
      </div>
    </div>
  );
}
