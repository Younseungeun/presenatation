"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import type { RiskCategory } from "@/domain/compliance";
import { ABUSE_REPLY_TITLE, ABUSE_RESUME_TITLE } from "@/domain/notice";
import { DirectMessage } from "./DirectMessage";
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

// `satisfies` 로 못 박는다 — 이 값들은 그대로 라벨이 되어 학습 자료에 실린다.
// 오타가 나면 서버가 거절하는 것이 아니라 **없는 유형으로 라벨이 붙는다**
const CATEGORY_OPTIONS = [
  ["SOLICIT_CONTACT", "1:1 상담·외부 채널 유도"],
  ["PROFIT_GUARANTEE", "수익 보장·손실 보전"],
  ["RISK_INDUCEMENT", "위험 투자 조장"],
  ["RUMOR", "출처 불명 풍문"],
  ["PRIVATE_INFO", "미공개 중요정보 정황"],
] as const satisfies readonly (readonly [RiskCategory, string])[];

export function AbuseGroupResolve({
  reportId,
  reporterCount,
  reporters,
  researcherUserId,
  researcherName,
}: {
  reportId: string;
  reporterCount: number;
  /** 들어온 신고 목록 — 실행 직전 확인 창에서만 펼친다 (AbuseUserCaught의 ReportersPart) */
  reporters?: ReactNode;
  /** 철회 확인 창에서 이 사람에게 직접 쪽지를 쓴다 */
  researcherUserId?: string | null;
  researcherName?: string | null;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<"CONFIRMED" | "REJECTED" | null>(null);
  const [category, setCategory] = useState<RiskCategory | "">("");
  const [manual, setManual] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 확인 창 — **강제 철회에만 선다** (2026-08-20 사용자 지시).
  //
  // 처음엔 기각에도 세웠는데, 기각 쪽에는 이미 `오신고로 확인했다 — 신고자 N명
  // 전원에게 통지` 체크박스가 있다. 그것이 곧 "이 사람들을 오신고자로 만든다"는
  // 확인이라, 창을 하나 더 띄우면 **같은 것을 두 번 묻는 것**이 된다.
  const [asking, setAsking] = useState(false);

  const confirming = decision === "CONFIRMED";
  const rejecting = decision === "REJECTED";
  const ready =
    note.trim().length > 0 && (rejecting || (confirming && category !== ""));
  const missing = !decision
    ? "위반인지 아닌지 먼저 골라 주세요"
    : confirming && !category
      ? "실제 위반 유형을 골라야 철회할 수 있습니다 — 검수가 놓친 것의 기록이 됩니다"
      : !note.trim()
        ? // **가는 곳을 정확히 적는다** (2026-08-20). 예전 문구는 "신고자에게 그대로
          // 갑니다"였는데 사실이 아니다 — 신고자 알림은 고정 문장이고, 이 글이 가는
          // 곳은 양쪽 모두 **리서처**다
          confirming
          ? "사유를 적어야 합니다 — 미탐 기록과 감사 스냅샷에 남습니다"
          : "사유를 적어야 합니다 — 기록에 남고 반복 무고 판단의 근거가 됩니다"
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
          category: confirming && category ? category : undefined,
          phrase: confirming && manual && phrase.trim() ? phrase.trim() : undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "처리에 실패했습니다");
      // 건너뛴 것·등록 실패는 조용히 넘기지 않는다 — 성공 화면 뒤에 숨은 미완이 가장 나쁘다
      const parts: string[] = [];
      if (json.takedownSkipped) parts.push(`철회는 건너뛰었습니다: ${json.takedownSkipped}`);
      if (json.phraseWarning) parts.push(`사전 미등록: ${json.phraseWarning}`);
      // **왜 근사 표기 감시에서 빠졌는지는 지금 말해야 한다** (회신 5호 Q1) —
      // 등록 직후 한 번뿐인 정보라, 화면을 새로 그리면 사라진다
      if (json.phraseCollisions?.length) {
        parts.push(
          `등록됐지만 근사 표기 감시에서는 빠집니다 — 한 글자 흐트러뜨린 형태가 ` +
            `${json.phraseCollisions.map((x: string) => `“${x}”`).join(" · ")}와 부딪힙니다 ` +
            `(정확 표기 감시는 그대로 돕니다)`,
        );
      }
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
              등록한 표현은 사전에 올라가 <b>다음 리서처가 글을 쓰는 중에</b> 같은 표현에서
              경고를 띄웁니다 — 검수 범위가 운영 중에 넓어지는 유일한 통로입니다.
            </>
          }
        >
          위반이 맞다면
        </WhyLabel>
        <div className={a.chips}>
          {CATEGORY_OPTIONS.map(([v, l]) => (
            <button
              key={v}
              type="button"
              className={`${a.pick} ${category === v ? a.pickOn : ""}`}
              onClick={() => {
                setCategory((c) => (c === v ? "" : v));
                setDecision(category === v ? null : "CONFIRMED");
              }}
            >
              {l}
            </button>
          ))}
          <button
            type="button"
            className={`${a.pick} ${a.pickMore} ${manual ? a.pickOn : ""}`}
            onClick={() => setManual((v) => !v)}
          >
            사전에 등록 ✎
          </button>
        </div>
        {manual && (
          <PhraseField
            value={phrase}
            onChange={setPhrase}
            category={category || undefined}
            placeholder="사전에 등록 — 예: 오픈채팅방에서 안내"
          />
        )}

        {/* **여기가 미탐 경로다** — 검수가 놓쳤고 이용자가 잡아 준 건이라, 라벨로서
            가장 값지고 동시에 **가장 조용히 버려지는** 자리다(유형 미지목이면
            operatorTraining 이 통째로 버린다). 두 갈래를 그려 그 사실을 앞에 놓는다 */}
        <TwoPaths takedown phrase={manual ? phrase.trim() : ""} categoryCount={category ? 1 : 0} />
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
        <label className={a.check}>
          <input
            type="checkbox"
            checked={rejecting}
            onChange={(e) => setDecision(e.target.checked ? "REJECTED" : null)}
          />
          {/* 가는 곳을 **둘 다** 적는다 (2026-08-20 사용자 지시) — 기각은 신고자만의
              일이 아니다. 판매가 다시 열리는 쪽이 리서처이고, 그 사람도 통지를 받는다 */}
          오신고로 확인했다 — 신고자 {reporterCount}명/리서처에게 통지
        </label>
      </div>

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
