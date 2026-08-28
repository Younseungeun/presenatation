"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import {
  CARD_BASED_CATEGORIES,
  isBuiltinCategory,
  OPERATOR_VIOLATION_CATEGORIES,
  violationLabel,
  type RiskCategory,
} from "@/domain/compliance";
import { ABUSE_REPLY_TITLE, ABUSE_RESUME_TITLE } from "@/domain/notice";
import { DirectMessage } from "./DirectMessage";
import { EvidencePicker } from "./compliance/EvidencePicker";
import { PhraseField } from "./PhraseField";
import { WhyLabel } from "./Why";
import a from "./admin.module.css";
import { TwoPaths } from "./TwoPaths";

// 신고 그룹의 판단 폼 — **판단 하나가 전부를 정한다** (2026-08-19 사용자 확정).
//
// 시안 v3의 갈래 문법: 두 결말을 나란히 펴 두고 **고른 쪽만 살린다.**
//   · 위반이 맞다 → 유형(미탐 라벨) + 사유 → **확인 · 강제 철회** 🔒
//     전액 환불·수수료 0·점수 0·미탐 기록·신고자 전원 통지·첫 신고자 보상, 한 번에.
//     학습 표현은 선택 — 등록하면 다음 리서처가 같은 문구를 쓰는 중에 경고를 받는다
//   · 위반이 아니다 → 사유 → **기각 · 판매 재개** — 전원 통지·무고 기록
//
// 반대쪽이 회색이 되는 것이 이 폼의 절반이다: 결과가 정반대인 두 버튼이 같은 얼굴로
// 나란히 있으면 **어느 쪽을 누르기로 했는지가 화면에 없다.**

export function AbuseGroupResolve({
  reportId,
  reporterCount,
  reporters,
  researcherUserId,
  researcherName,
  content,
  cardText,
  customTypes = [],
}: {
  reportId: string;
  reporterCount: number;
  /** 들어온 신고 목록 — 실행 직전 확인 창에서만 펼친다 (AbuseUserCaught의 ReportersPart) */
  reporters?: ReactNode;
  /** 철회 확인 창에서 이 사람에게 직접 쪽지를 쓴다 */
  researcherUserId?: string | null;
  researcherName?: string | null;
  /** 리포트 본문 — 근거 문장 짚기(EvidencePicker)에 쓴다 */
  content?: string | null;
  /** 예측 카드 값(종목·수익률 등) — 본문에 없는 항목을 짚게 한다 (2026-08-28) */
  cardText?: string | null;
  /** 운영자가 정의한 커스텀 위반 유형 라벨 — 내장 9개 뒤에 칩으로 붙는다 */
  customTypes?: string[];
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<"CONFIRMED" | "REJECTED" | null>(null);
  // 내장 key 또는 커스텀 라벨(문자열) — 통일 세트라 둘을 한 문자열로 다룬다
  const [category, setCategory] = useState<string>("");
  // "위반 유형 추가" — 새 유형을 손으로 적는다. 적는 동안 그 값이 곧 선택된 유형이 된다
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState("");
  // "실시간 표현 등록" (복원 2026-08-28, 회신 24호 답장 §4) — 위반 유형 추가와 **다른 물건**:
  // 유형 추가는 재학습 라벨, 이건 리서처가 글 쓰는 중에 그 어구에서 즉시 WARN 뜨게 하는
  // 학습 표현. 승격 사다리의 "빠른 입구"라 되살린다. 고른 내장 유형 아래 등록된다
  const [phraseOpen, setPhraseOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [note, setNote] = useState("");
  // 근거 문장 지목 — 강제철회·지적타당에서 필수 (2026-08-28)
  const [evidence, setEvidence] = useState<string[]>([]);
  // 기각의 두 갈래 — false=오신고(무고), true=지적은 타당했으나 위반 아님(경미).
  // rejecting 일 때만 의미가 있고, decision 이 null 로 풀리면 checked 가 저절로 꺼진다
  const [validConcern, setValidConcern] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 실제 제출될 유형 — 새 유형을 적는 중이면 그것이, 아니면 고른 칩이 이긴다
  const effectiveCategory = adding && newType.trim() ? newType.trim() : category;
  // 확인 창 — **강제 철회에만 선다** (2026-08-20 사용자 지시).
  //
  // 처음엔 기각에도 세웠는데, 기각 쪽에는 이미 `오신고로 확인했다 — 신고자 N명
  // 전원에게 통지` 체크박스가 있다. 그것이 곧 "이 사람들을 오신고자로 만든다"는
  // 확인이라, 창을 하나 더 띄우면 **같은 것을 두 번 묻는 것**이 된다.
  const [asking, setAsking] = useState(false);

  const confirming = decision === "CONFIRMED";
  const rejecting = decision === "REJECTED";
  // 근거 문장 필수 = IRIS 가 배울 지역화가 필요한 경우 (2026-08-28 창업자 확정):
  //   · 강제철회(미탐)      → 필수 (검수가 놓친 것, 무엇을 배울지 짚어야 한다)
  //   · 기각·지적타당(경계) → 필수 (모델이 배울 경계 사례)
  //   · 기각·오신고         → 불요 (모델은 옳게 통과시켰다)
  const needsEvidence = confirming || (rejecting && validConcern);
  const ready =
    note.trim().length > 0 &&
    (confirming ? effectiveCategory !== "" : true) &&
    (!needsEvidence || evidence.length > 0);
  const missing = !decision
    ? "위반인지 아닌지 먼저 골라 주세요"
    : confirming && !effectiveCategory
      ? "실제 위반 유형을 골라야 철회할 수 있습니다 — 검수가 놓친 것의 기록이 됩니다"
      : !note.trim()
        ? // **가는 곳을 정확히 적는다** (2026-08-20). 예전 문구는 "신고자에게 그대로
          // 갑니다"였는데 사실이 아니다 — 신고자 알림은 고정 문장이고, 이 글이 가는
          // 곳은 양쪽 모두 **리서처**다
          confirming
          ? "사유를 적어야 합니다 — 미탐 기록과 감사 스냅샷에 남습니다"
          : "사유를 적어야 합니다 — 기록에 남고 반복 무고 판단의 근거가 됩니다"
        : needsEvidence && evidence.length === 0
          ? "위반 근거 문장을 본문에서 짚어 주세요 — 재학습 자료의 근거가 됩니다"
          : "";

  // 확인 창이 떠 있는 동안 뒤 배경은 잠근다 — 스크롤이 따라 움직이면 창이
  // 화면 위에 얹힌 종이가 아니라 페이지의 일부처럼 보인다
  useEffect(() => {
    if (!asking) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAsking(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [asking]);

  /**
   * 버튼을 누르면 — 강제 철회는 **확인 창을 열고**, 기각은 곧장 실행한다.
   *
   * 고른 쪽 버튼은 **잉크로 살아 있다** — 잉크가 말하는 것은 "이쪽이 당신이 고른
   * 결말"이지 "지금 눌러도 된다"가 아니다. 덜 채운 채 누르면 조용히 아무 일도
   * 안 일어나는 대신 무엇이 빠졌는지 말한다.
   */
  // '위반이 아니라면'의 두 갈래 — 같은 것을 다시 누르면 해제(decision null)된다.
  // valid=false 오신고 / valid=true 지적은 타당(경미). 둘 다 기각(판매 재개)이고,
  // 무고 집계·학습 반영만 갈린다
  const pickReject = (valid: boolean) => {
    if (rejecting && validConcern === valid) {
      setDecision(null);
    } else {
      setValidConcern(valid);
      setDecision("REJECTED");
    }
  };

  const ask = () => {
    if (!decision) return;
    if (!ready) {
      setNotice(missing);
      return;
    }
    setError(null);
    if (confirming) setAsking(true);
    else void submit();
  };

  const submit = async () => {
    if (!decision || !ready) return;
    setAsking(false);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/abuse-reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportId,
          decision,
          note,
          // 내장 key 또는 새로 정의한 커스텀 유형 라벨 — 서버가 커스텀이면 ViolationType 에 올린다
          category: confirming && effectiveCategory ? effectiveCategory : undefined,
          // 실시간 학습 표현 — 확인(강제철회) 시에만. 서버가 고른 내장 유형 아래 등록한다
          phrase: confirming && phraseOpen && phrase.trim() ? phrase.trim() : undefined,
          // 근거 문장 지목 — 강제철회·지적타당의 재학습 자료 근거
          evidence: needsEvidence && evidence.length ? evidence : undefined,
          // 기각 + 지적 타당일 때만 참을 보낸다 (경미 → 무고 제외·학습 반영)
          findingsValid: rejecting && validConcern ? true : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "처리에 실패했습니다");
      // 건너뛴 것·등록 실패는 조용히 넘기지 않는다 — 성공 화면 뒤에 숨은 미완이 가장 나쁘다
      const parts: string[] = [];
      if (json.takedownSkipped) parts.push(`철회는 건너뛰었습니다: ${json.takedownSkipped}`);
      if (json.phraseWarning) parts.push(`실시간 표현 미등록: ${json.phraseWarning}`);
      if (parts.length) setNotice(parts.join(" · "));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "처리에 실패했습니다");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* ── 위반이 맞다면 ─────────────────────────────────────── */}
      <div className={`${a.branch} ${rejecting ? a.branchOff : ""}`}>
        <WhyLabel
          sub="실제 유형 — 신고자가 고른 것과 다를 수 있습니다"
          why={
            <>
              고른 유형은 <b>검수가 놓친 것(미탐)의 라벨</b>이 됩니다 — 재학습에서 가장 값진
              자료입니다. 없는 유형이면 <b>위반 유형 추가</b>로 새로 정의하세요 — 그 유형은
              이후 검수·어뷰징 선택기에 그대로 뜹니다.
            </>
          }
        >
          위반이 맞다면
        </WhyLabel>
        <div className={a.chips}>
          {/* 내장 9개 + 운영자가 정의한 커스텀 유형 — 두 화면 통일 세트 (2026-08-28) */}
          {[...OPERATOR_VIOLATION_CATEGORIES, ...customTypes].map((v) => {
            const on = !adding && category === v;
            return (
              <button
                key={v}
                type="button"
                className={`${a.pick} ${on ? a.pickOn : ""}`}
                onClick={() => {
                  setAdding(false);
                  setNewType("");
                  setCategory((c) => (c === v ? "" : v));
                  setDecision(category === v ? null : "CONFIRMED");
                }}
                title={CARD_BASED_CATEGORIES.has(v as RiskCategory) ? "예측 카드의 위반 — 아래 카드 값을 짚으세요" : undefined}
              >
                {violationLabel(v)}
                {CARD_BASED_CATEGORIES.has(v as RiskCategory) ? " ▦" : ""}
              </button>
            );
          })}
          <button
            type="button"
            className={`${a.pick} ${a.pickMore} ${adding ? a.pickOn : ""}`}
            onClick={() => {
              const next = !adding;
              setAdding(next);
              if (next) {
                setCategory("");
                setDecision("CONFIRMED");
              }
            }}
          >
            위반 유형 추가 ✎
          </button>
          {/* 실시간 표현 등록 — 유형 추가와 다른 축이라 나란히 둔다 (2026-08-28 복원) */}
          <button
            type="button"
            className={`${a.pick} ${a.pickMore} ${phraseOpen ? a.pickOn : ""}`}
            onClick={() => {
              setPhraseOpen((v) => !v);
              if (!phraseOpen && !decision) setDecision("CONFIRMED");
            }}
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
              강제 철회하면 이 유형이 <b>위반 유형 목록에 추가</b>되어 다음부터 칩으로 뜹니다.
            </div>
          </div>
        )}
        {/* 학습 표현 = 리서처가 글 쓰는 중에 즉시 WARN 뜨는 어구. **고른 내장 유형 아래**
            등록된다(커스텀 유형 아래엔 안 된다 — 커스텀은 라벨 전용). 승격 사다리의 빠른 입구 */}
        {phraseOpen && (
          <PhraseField
            value={phrase}
            onChange={setPhrase}
            category={isBuiltinCategory(effectiveCategory) ? effectiveCategory : undefined}
            placeholder="실시간 표현 — 예: 오픈채팅방에서 안내"
          />
        )}

        {/* **여기가 미탐 경로다** — 검수가 놓쳤고 이용자가 잡아 준 건이라, 라벨로서
            가장 값지고 동시에 **가장 조용히 버려지는** 자리다(유형 미지목이면
            operatorTraining 이 통째로 버린다). 두 갈래를 그려 그 사실을 앞에 놓는다 */}
        <TwoPaths takedown phrase="" categoryCount={effectiveCategory ? 1 : 0} />
      </div>

      {/* ── 위반이 아니라면 ───────────────────────────────────── */}
      <div className={`${a.branch} ${confirming ? a.branchOff : ""}`}>
        <WhyLabel
          why={
            <>
              고의적인 허위 신고가 반복되면 그 기록이 제재 근거가 됩니다. 기각하면 판매가
              그 자리에서 다시 열립니다.
            </>
          }
        >
          위반이 아니라면
        </WhyLabel>
        {/* 기각은 두 갈래다 (2026-08-27 창업자 지시) — 둘 다 판매 재개·양쪽 통지지만
            무고 집계와 학습 반영이 갈린다. 순수 오신고만 무고 이력에 남는다 */}
        <label className={a.check}>
          <input
            type="checkbox"
            checked={rejecting && !validConcern}
            onChange={() => pickReject(false)}
          />
          {/* 가는 곳을 **둘 다** 적는다 (2026-08-20 사용자 지시) — 기각은 신고자만의
              일이 아니다. 판매가 다시 열리는 쪽이 리서처이고, 그 사람도 통지를 받는다 */}
          오신고였다 — 무고 이력에 남고, 신고자 {reporterCount}명·리서처에게 통지
        </label>
        <label className={a.check}>
          <input
            type="checkbox"
            checked={rejecting && validConcern}
            onChange={() => pickReject(true)}
          />
          {/* 성실한 지적이나 위반까지는 아님 — 무고로 세지 않고, 경계 사례로 학습에 남긴다
              (검수 기록에 KEPT + findingsValid=true → 교사 질문지 생성) */}
          지적은 타당했으나 위반은 아니다 — 무고로 세지 않고 경계 사례로 남깁니다
        </label>
      </div>

      {/* 근거 문장 짚기 — 강제철회(미탐)·지적타당(경계)에서 **필수** (2026-08-28).
          IRIS 가 그 문장 창만 위반으로 배운다. 카드형 위반은 본문에 없어, 예측 카드 값을
          다른 글꼴로 실어 그것을 짚게 한다(EvidencePicker cardText). 오신고에는 안 뜬다 */}
      {needsEvidence && (
        <div className={a.field}>
          <div className={a.lbl}>
            근거 문장 <small>필수 — 본문(또는 예측 카드 값)에서 위반 근거를 짚어 주세요</small>
          </div>
          <EvidencePicker
            content={content ?? null}
            cardText={cardText ?? null}
            value={evidence}
            onChange={setEvidence}
            required
          />
        </div>
      )}

      {/* **이 칸은 기록이다 — 남에게 보내는 글이 아니다** (2026-08-20 사용자 확정).
          기각 통지는 양쪽 다 고정 양식으로 나가므로 여기 쓴 글은 reviewNote에만
          남는다(반복 무고 판단의 근거). 확인일 때만 리서처의 철회 통지에 실린다 */}
      <div className={a.field}>
        <input
          className={a.input}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={
            rejecting
              ? "기각 사유 (기록용) — 예: 인용된 문구가 본문에 없음"
              : "검토 사유 — 예: 본문에 오픈채팅 유도 문구 확인"
          }
          aria-label="검토 사유"
          maxLength={2000}
        />
      </div>
      {rejecting && (
        <div className={a.hint}>
          기각하면 리서처에게 <b>{ABUSE_RESUME_TITLE}</b>, 신고자 {reporterCount}명에게{" "}
          <b>{ABUSE_REPLY_TITLE}</b>가 정해진 문구로 나갑니다.
        </div>
      )}

      {/* **미리보기를 두지 않는다** (2026-08-20 사용자 지시).
          두 가지가 겹쳤다:
          ① 신고자에게 할 말은 이제 **개별 쪽지**로 보낸다(DirectMessage) — 기각이든
             철회든 그 사람 글 위에서 직접 쓴다
          ② 애초에 **사실이 아니었다.** 이 사유는 신고자에게 가지 않는다 —
             신고자가 받는 알림은 고정 문장이고(abuseReportService의 통지 본문),
             이 글이 실제로 가는 곳은 확인 시 **리서처의 강제 철회 통지**뿐이다.
             "전달될 사유 · 신고자 전원"은 화면이 하던 거짓말이었다 */}
      {/* **접지 않고, 고른 뒤에만 보이지도 않는다** (시안) — 이것은 "왜 그런가"가 아니라
          잉크 버튼이 무엇을 하는지다. 누르기 전에 읽혀야 하므로 늘 떠 있다 */}
      <div className={`${a.note} ${a.noteNeg}`}>
        확인하면 강제 철회 — 전액 환불 · 수수료 0 · 점수 0. <b>되돌릴 수 없습니다.</b>
      </div>

      {/* **고른 쪽이 잉크가 된다** (2026-08-20 사용자 지시).
          전에는 사유까지 다 채워야 잉크가 됐는데, 그러면 유형을 고른 직후 화면에
          아무 변화가 없어 **내가 무엇을 골랐는지가 화면에 없었다.** 잉크는 결말을
          가리키고, 아직 못 누르는 이유는 아래 회색 줄(.gate)이 말한다.
          `disabled`를 걸면 CSS가 잉크를 회색으로 덮으므로(.btn:disabled) 고른 쪽은
          살려 두고, 덜 채운 채 누르면 submit이 빠진 것을 알린다 */}
      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${rejecting && !busy ? a.btnInk : a.btnLine} ${
            confirming ? a.blocked : ""
          }`}
          disabled={!rejecting || busy}
          onClick={ask}
        >
          {busy && rejecting ? "처리 중…" : "기각 · 판매 재개"}
        </button>
        <button
          type="button"
          className={`${a.btn} ${confirming && !busy ? a.btnInk : a.btnLine} ${
            rejecting ? a.blocked : ""
          }`}
          disabled={!confirming || busy}
          onClick={ask}
        >
          {busy && confirming ? "처리 중…" : "확인 · 강제 철회"}
          <span className={a.fp}>🔒</span>
        </button>
      </div>

      {missing && <div className={a.gate}>{missing}</div>}
      {error && <p className={a.error}>{error}</p>}
      {notice && (
        <p className={a.hint} style={{ color: "var(--warn)", fontWeight: 700 }}>
          {notice}
        </p>
      )}

      {/* ── 실행 직전 확인 창 (강제 철회 전용) ──────────────────────
          `window.confirm`을 걷어내고 이 창이 대신한다. 브라우저 confirm은 한 줄밖에
          못 싣는데, 여기서 확인해야 할 것은 문장이 아니라 **누구의 말 위에 서 있는
          판단인가**이기 때문이다 — 신고자들의 이름·시각·고른 유형이 그 답이고,
          그것을 카드에 늘 펼쳐 두는 대신 이 순간에만 펼친다 (2026-08-20 사용자 지시).
          기각에는 세우지 않는다 — 위 `오신고로 확인했다` 체크박스가 이미 같은 것을
          묻고 있고, 같은 질문을 두 번 하면 두 번째는 습관으로 눌린다 */}
      {asking && (
        <>
          <button
            type="button"
            className={a.scrim}
            aria-label="닫기"
            onClick={() => setAsking(false)}
          />
          <div className={a.sheet} role="dialog" aria-modal="true" aria-label="확인 · 강제 철회">
            <div className={a.sheetHead}>
              <div className={a.sheetTtl}>확인 · 강제 철회</div>
              <div className={`${a.note} ${a.noteNeg}`}>
                판매가 내려가고 구매자 전원에게 <b>전액 환불</b>됩니다 — 수수료 0 · 점수 0 ·
                미탐으로 기록. <b>되돌릴 수 없습니다.</b>
              </div>
              {/* **적어 둔 사유를 다시 보여주지 않는다** (2026-08-20 사용자 지시).
                  그 글은 이제 통지에 실리지 않는다 — 기록(reviewNote)과 감사 스냅샷으로만
                  남는다. 방금 자기가 친 문장을 그대로 되비추는 상자는 확인해 줄 것이
                  없고, 무엇보다 **정작 지금 써야 할 상자**(아래)를 밀어냈다.
                  이 자리는 맨 위 — 철회의 첫 당사자가 리서처이기 때문이다.
                  **선택이다**: 안 써도 철회는 실행된다. 다만 자동 통지를 껐으므로
                  안 쓰면 리서처는 아무 말도 못 듣는다 */}
              {researcherUserId && researcherName && (
                <>
                  <div className={a.lbl}>
                    리서처에게 <small>안 쓰면 아무 안내도 가지 않습니다</small>
                  </div>
                  <DirectMessage
                    userId={researcherUserId}
                    name={researcherName}
                    quote={`${researcherName} 님에게 할 말 쓰기`}
                    action="알림"
                  />
                </>
              )}
            </div>

            <div className={a.sheetBody}>
              {/* 자동 통지를 껐으므로 **안 쓰면 아무 말도 안 간다** — 이 사실을
                  목록 위에 한 줄로 둔다. 특히 보상 대상자에게는 그 사실을 알릴
                  다른 통로가 없다(줄 옆의 `보상 대상` 칩이 누구인지 말해 준다) */}
              <div className={a.note}>
                여기서 쓴 쪽지만 나갑니다 — 자동 안내는 보내지 않습니다.
              </div>
              {reporters}
            </div>

            <div className={`${a.sheetFoot} ${a.btnrow}`}>
              <button
                type="button"
                className={`${a.btn} ${a.btnLine}`}
                onClick={() => setAsking(false)}
                disabled={busy}
              >
                취소
              </button>
              <button
                type="button"
                className={`${a.btn} ${a.btnInk}`}
                onClick={submit}
                disabled={busy}
              >
                {busy ? "처리 중…" : "강제 철회 실행"}
                <span className={a.fp}>🔒</span>
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
