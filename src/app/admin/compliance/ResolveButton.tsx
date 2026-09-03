"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  CARD_BASED_CATEGORIES,
  isBuiltinCategory,
  OPERATOR_VIOLATION_CATEGORIES,
  violationLabel,
  type RiskCategory,
} from "@/domain/compliance";
import a from "../admin.module.css";
import { PhraseField } from "../PhraseField";
import { TwoPaths } from "../TwoPaths";
import { EvidencePicker } from "./EvidencePicker";

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
  content = null,
  cardText = null,
  customTypes = [],
  measure = false,
}: {
  /** 검토 큐 항목일 때만 존재 — 판매 중 목록에서 온 건은 없다 */
  reviewId?: string;
  reportId: string;
  reportStatus: string;
  heldPurchases: number;
  heldAmountKrw: number;
  /** 검수가 지적한 유형 — 반려 시 실제 위반 유형의 기본 선택값이 된다 */
  flaggedCategories?: RiskCategory[];
  /** 리포트 본문 — 반려·철회·승인 때 근거 문장 지목(EvidencePicker)에 쓴다 (회신 20호 요청 3) */
  content?: string | null;
  /** 예측 카드 값(종목·수익률 등) — 본문에 없는 카드형 위반을 짚게 한다 (2026-08-28) */
  cardText?: string | null;
  /** 운영자가 정의한 커스텀 위반 유형 — 내장 9개 뒤에 칩으로 붙는다 */
  customTypes?: string[];
  /**
   * 판단 소요 시간을 재서 함께 보낼 것인가.
   * **큐에서 펼친 카드에서만 참이다** — 이 컴포넌트의 마운트가 곧 열람인 자리.
   */
  measure?: boolean;
}) {
  const router = useRouter();
  // 마운트 시각 = 이 건을 펼친 시각. 렌더가 다시 돌아도 흔들리면 안 되므로 ref 다.
  // **렌더 중에 찍지 않는다** — `useRef(Date.now())` 는 렌더가 순수해야 한다는 규칙을
  // 어기고(재렌더마다 다른 값이 나올 수 있다), 린트가 막는다. 효과에서 한 번만 찍는다
  const openedAt = useRef<number | null>(null);
  useEffect(() => {
    openedAt.current = Date.now();
  }, []);
  const [reason, setReason] = useState("");
  // 근거 문장 지목 (회신 20호 요청 3) — 반려·철회 때 본문에서 짚은 위반 문장들
  const [evidence, setEvidence] = useState<string[]>([]);
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
  // '지적은 타당했지만 승인한' 사유 — findingsValid !== null 일 때만 입력받는다 (2026-08-27)
  const [approveReason, setApproveReason] = useState("");
  // 내장 key + 커스텀 라벨(문자열) — 통일 세트 (2026-08-28)
  const [categories, setCategories] = useState<string[]>(flaggedCategories);
  // "위반 유형 추가" — 새 유형을 손으로 적어 목록에 더한다
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState("");
  // "실시간 표현 등록" (복원 2026-08-28, 회신 24호 답장 §4) — 위반 유형 추가와 다른 축:
  // 유형 추가는 재학습 라벨, 이건 리서처가 작성 중에 즉시 WARN 뜨는 학습 표현. 고른 내장
  // 유형 아래 등록된다. 승격 사다리의 빠른 입구
  const [phraseOpen, setPhraseOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [warning, setWarning] = useState<string | null>(null);
  /** 등록 직후 한 번만 보여줄 근사 표기 충돌 상대 — 화면을 새로 그리면 사라진다 */
  const [collisions, setCollisions] = useState<string[] | null>(null);

  const pending = reportStatus === "PENDING_REVIEW";
  const takedown = !pending && reportStatus === "PUBLISHED";

  // 실제 제출될 유형 — 새 유형을 적는 중이면 목록에 더해 보낸다 (다중 선택)
  const effectiveCategories =
    adding && newType.trim() ? [...categories, newType.trim()] : categories;

  // **본문(모델) 소견이 있는 보류인가** (2026-08-28 창업자 확정 Q2).
  // 검수가 짚은 유형 중 운영자 라벨용(내용·카드) 유형이 하나라도 있으면 "본문 소견 보류"다.
  // 위험 종목·판정불가 반복 같은 시스템 신호만 있는 보류는 모델의 텍스트 판단이 아니므로,
  // 승인해도 오탐/지적타당 라벨을 강제하지 않는다(그걸 오탐으로 세면 ARGOS 정확도가 거짓으로 나빠진다)
  const contentHold = flaggedCategories.some((c) => OPERATOR_VIOLATION_CATEGORIES.includes(c));

  // **사람이 한 행동만 센다.** 검수 소견은 처음부터 들어 있으므로(flaggedCategories)
  // 그걸로 "반려 갈래를 골랐다"고 보면 승인이 영영 회색이 된다
  const touchedReject =
    reason.trim().length > 0 ||
    adding ||
    categories.length !== flaggedCategories.length ||
    categories.some((c) => !(flaggedCategories as string[]).includes(c));
  const touchedApprove = findingsValid !== null;

  const rejecting = touchedReject;
  const approving = touchedApprove;

  function toggle(c: string) {
    setCategories((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  }

  // '위반이 아니라면' 라디오는 **선택된 것을 다시 누르면 해제**된다 (2026-08-27 창업자 지시).
  // 같은 값을 다시 누르면 null(표시하지 않고 승인 — 기본)로 돌아간다.
  // null(표시하지 않고 승인) 자체는 기본 상태라 다시 눌러도 null 그대로다
  function pickValidity(v: boolean | null) {
    setFindingsValid((prev) => (prev === v ? null : v));
  }

  /**
   * **열람 → 판정까지 걸린 시간** (26차 CC-1 반증 조건 — 피로도 함정 감지).
   *
   * 라이브 ARGOS를 유지하는 대가는 오탐 흡수인데, 오탐 승인과 정상 승인이 화면에서
   * **같은 클릭**이라 결과만으로는 구별되지 않는다. 갈라 주는 유일한 신호가 시간이다:
   * 특정 유형의 판단이 다른 유형의 절반 밑으로 떨어지면 그 소견은 읽히지 않고 있다.
   *
   * **재는 자리가 곧 정의다.** 이 컴포넌트는 큐 카드가 *펼쳐졌을 때만* 마운트되므로
   * (`ReviewCard` 는 접힌 상태에서 링크만 그린다) 마운트 시각이 곧 열람 시각이다.
   * 반면 판매 중 목록은 카드마다 이 폼을 한꺼번에 그리므로 마운트가 "열었다"가
   * 아니다 — 거기서 재면 페이지를 띄워 둔 시간이 판단 시간으로 둔갑한다.
   * 그래서 `measure` 를 명시적으로 받는다.
   *
   * 창 비활성 시간은 빼지 않는다(과공학) — 자리를 비워 부푼 값은 서버가 하루 상한으로
   * 자른다. **짧은 것이 신호이고 긴 것은 신중이라**, 위쪽 오차는 이 지표를 안 망친다.
   */
  function elapsedField(action: unknown): { decisionElapsedMs?: number } {
    if (!measure || openedAt.current === null) return {};
    if (action !== "APPROVE" && action !== "REJECT" && action !== "TAKEDOWN") return {};
    return { decisionElapsedMs: Math.max(1, Date.now() - openedAt.current) };
  }

  async function post(body: Record<string, unknown>, failMessage: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body, ...elapsedField(body.action) }),
      });
      const payload = await res.json();
      if (!res.ok) {
        setError(payload.issues ? payload.issues.join(" / ") : (payload.error ?? failMessage));
        return;
      }
      // 처리는 됐는데 실시간 표현 등록만 실패한 경우 — 되돌리지 않고 알리기만 한다
      if (payload.phraseWarning) {
        setWarning(payload.phraseWarning);
        return;
      }
      // 등록 직후 딱 한 번 근사 표기 충돌 상대를 보여준다 (회신 5호 Q1)
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
  // 반려·철회 요건 (2026-08-28): 유형 ≥1 필수 · 사유 필수(→리서처 문자).
  // 근거 문장은 **철회(미탐)만 필수**, 반려(정탐)는 선택 — ARGOS 가 이미 옳게 잡았으므로.
  const negMissing = !effectiveCategories.length
    ? `실제 위반 유형을 하나 이상 골라야 ${takedown ? "철회" : "반려"}할 수 있습니다`
    : !reason.trim()
      ? `${takedown ? "철회" : "반려"} 사유를 적어야 합니다 — 리서처에게 그대로 갑니다`
      : takedown && evidence.length === 0
        ? "위반 근거 문장을 짚어 주세요 — 강제 철회는 미탐 재학습 자료입니다"
        : "";
  // 게시 승인 요건 (2026-08-28): **본문 소견 보류**면 오탐/지적타당 + 근거 필수.
  // 위험 종목만의 보류는 라벨 없이 승인(contentHold=false → posMissing 없음)
  const posMissing =
    contentHold && findingsValid === null
      ? "오탐인지 지적이 타당했는지 골라야 승인할 수 있습니다"
      : contentHold && evidence.length === 0
        ? "근거 문장을 짚어 주세요 — 승인은 재학습 자료(가중치·졸업 논의)의 근거입니다"
        : "";
  const negLive = !approving && !negMissing && !busy;
  const posLive = !rejecting && !posMissing && !busy;

  return (
    <>
      {/* ── 위반이 맞다면 ─────────────────────────────────────── */}
      <div className={`${a.branch} ${approving ? a.branchOff : ""}`}>
        <div className={a.lbl}>
          위반이 맞다면
          <small>실제 유형 — 검수가 짚은 것과 다를 수 있습니다</small>
        </div>
        <div className={a.chips}>
          {/* 내장 9개 + 커스텀 유형 — 어뷰징과 같은 통일 세트 (2026-08-28) */}
          {[...OPERATOR_VIOLATION_CATEGORIES, ...customTypes].map((c) => (
            <button
              key={c}
              type="button"
              className={`${a.pick} ${categories.includes(c) ? a.pickOn : ""}`}
              onClick={() => toggle(c)}
              title={CARD_BASED_CATEGORIES.has(c as RiskCategory) ? "예측 카드의 위반 — 아래 카드 값을 짚으세요" : undefined}
            >
              {violationLabel(c)}
              {CARD_BASED_CATEGORIES.has(c as RiskCategory) ? " ▦" : ""}
            </button>
          ))}
          <button
            type="button"
            className={`${a.pick} ${a.pickMore} ${adding ? a.pickOn : ""}`}
            onClick={() => setAdding((v) => !v)}
          >
            위반 유형 추가 ✎
          </button>
          {/* 실시간 표현 등록 — 유형 추가와 다른 축이라 나란히 (2026-08-28 복원) */}
          <button
            type="button"
            className={`${a.pick} ${a.pickMore} ${phraseOpen ? a.pickOn : ""}`}
            onClick={() => setPhraseOpen((v) => !v)}
          >
            실시간 표현 등록 ✎
          </button>
        </div>

        {adding && (
          <div className={a.field}>
            <input
              className={a.input}
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              placeholder="새 위반 유형 — 예: 논리적 비약"
              aria-label="새 위반 유형"
              maxLength={40}
            />
            <div className={a.hint}>
              반려·철회하면 이 유형이 <b>위반 유형 목록에 추가</b>되어 다음부터 칩으로 뜹니다.
            </div>
          </div>
        )}

        {/* 학습 표현 = 리서처가 작성 중에 즉시 WARN 뜨는 어구. **고른 내장 유형 아래** 등록.
            승격 사다리의 빠른 입구 (커스텀 유형 아래엔 안 된다 — 커스텀은 라벨 전용) */}
        {phraseOpen && (
          <PhraseField
            value={phrase}
            onChange={setPhrase}
            category={categories.find((c) => isBuiltinCategory(c)) as RiskCategory | undefined}
            placeholder="실시간 표현 — 예: 반드시 오릅니다"
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

        {/* '전달될 사유' 미리보기 박스는 걷었다 (2026-08-27 창업자 지시) — 바로 위
            입력란이 곧 리서처에게 갈 문장 그대로라(placeholder·aria-label이 그렇게 말한다)
            아래에 같은 값을 한 번 더 비추는 박스는 중복이었다 */}

        <TwoPaths takedown={takedown} phrase="" categoryCount={effectiveCategories.length} />
      </div>

      {/* ── 위반이 아니라면 ───────────────────────────────────── */}
      <div className={`${a.branch} ${rejecting ? a.branchOff : ""}`}>
        <div className={a.lbl}>위반이 아니라면</div>
        {contentHold ? (
          <>
            {/* **라벨 없는 승인을 없앴다** (2026-08-28 창업자 확정). 본문 소견이 있는 보류를
                승인한다면 그것은 오탐(모델이 틀림) 아니면 지적 타당(맞지만 통과) 둘 중 하나다 —
                아무 표시 없이 넘기면 재학습에서 가장 값진 자료(승인 사례)가 버려진다.
                선택된 동그라미를 다시 누르면 해제된다 (checked 라디오는 onChange 가 안 뜬다) */}
            <label className={a.check}>
              <input
                type="radio"
                name={`fv-${reportId}`}
                checked={findingsValid === false}
                onChange={() => {}}
                onClick={() => pickValidity(false)}
              />
              <b>오탐이었다</b> — 이 지적은 부적절했습니다 (가중치 조절 자료)
            </label>
            <label className={a.check}>
              <input
                type="radio"
                name={`fv-${reportId}`}
                checked={findingsValid === true}
                onChange={() => {}}
                onClick={() => pickValidity(true)}
              />
              지적 자체는 타당했다 (경미해서 통과 — 졸업 논의 자료)
            </label>
            <p className={a.hint}>
              오탐이 쌓이면 모델이 스스로 검수에서 내려갑니다. 두 경우 모두{" "}
              <b>근거 문장을 짚어야</b> — ARGOS 가 무엇을 다시 배울지 지역화됩니다.
            </p>
            {pending && findingsValid !== null && (
              <div className={a.field} style={{ marginTop: 8 }}>
                <textarea
                  className={a.textarea}
                  rows={2}
                  value={approveReason}
                  onChange={(e) => setApproveReason(e.target.value)}
                  maxLength={500}
                  placeholder={
                    findingsValid === true
                      ? "지적은 타당한데 왜 게시 승인했나요? — 어느 부분이 경미하다고 봤는지 (교사 질문지에 실립니다)"
                      : "왜 오탐인가요? — 이 지적이 왜 부적절한지 (검수 규칙 점검·재학습에 실립니다)"
                  }
                  aria-label="승인 사유"
                />
              </div>
            )}
          </>
        ) : (
          // 위험 종목·판정불가 반복 같은 **시스템 신호만의 보류** — 모델의 텍스트 판단이
          // 아니라 승인해도 오탐/지적타당 라벨이 없다. 그대로 통과시킨다 (2026-08-28 Q2)
          <p className={a.hint}>인정할 본문 소견이 없습니다 — 그대로 통과시킵니다.</p>
        )}
      </div>

      {/* 근거 문장 짚기 — 두 갈래가 함께 쓴다 (2026-08-28). 반려(선택)·강제철회(필수)·
          게시 승인(본문 소견이면 필수). 어느 브랜치에 있어도 회색이 되지 않게 중립 위치에 둔다.
          카드형 위반은 본문에 없어, 예측 카드 값을 다른 글꼴로 실어 짚게 한다(cardText) */}
      {(rejecting || takedown || (approving && contentHold)) && (
        <div className={a.field}>
          <div className={a.lbl}>
            근거 문장
            <small>
              {takedown || (approving && contentHold)
                ? "필수 — 본문(또는 예측 카드 값)에서 근거를 짚어 주세요"
                : "선택 — 짚으면 ARGOS 가 그 문장 창만 배웁니다"}
            </small>
          </div>
          <EvidencePicker
            content={content}
            cardText={cardText}
            reportId={reportId}
            categories={effectiveCategories}
            value={evidence}
            onChange={setEvidence}
            required={takedown || (approving && contentHold)}
          />
        </div>
      )}

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
              ? post(
                  {
                    action: "APPROVE",
                    reportId,
                    findingsValid,
                    // findingsValid 를 표시했을 때만(지적 타당·오탐) 실어 보낸다 — 서버도 그 경우만 저장
                    approveReason: findingsValid !== null ? approveReason : undefined,
                    // 본문 소견 승인의 근거 문장 — 재학습 지역화 (2026-08-28)
                    evidence: contentHold && evidence.length ? evidence : undefined,
                  },
                  "승인 실패",
                )
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
                  // 내장 key + 커스텀 라벨 — 서버가 커스텀이면 ViolationType 에 올린다
                  categories: effectiveCategories,
                  evidence: evidence.length ? evidence : undefined,
                  // 실시간 학습 표현 — 서버가 고른 내장 유형 아래 등록
                  phrase: phraseOpen && phrase.trim() ? phrase.trim() : undefined,
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
          처리는 완료됐지만 실시간 표현은 등록되지 않았습니다: {warning}
        </p>
      )}
      {collisions && <CollisionNotice against={collisions} onClose={() => router.refresh()} />}
    </>
  );
}

/**
 * 왜 근사 표기 감시에서 빠졌는지 — **등록 직후 한 번**. 이 표현의 한 글자 이웃에 정상
 * 낱말이 있어 근사 매칭을 켜면 그것들까지 잡히므로, 그 사실을 등록 순간에 한 번 알린다.
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
