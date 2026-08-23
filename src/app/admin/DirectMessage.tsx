"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  ABUSE_REPLY_TITLE,
  checkNoticeText,
  NOTICE_BODY_MAX,
  NOTICE_BODY_MIN,
} from "@/domain/notice";
import a from "./admin.module.css";

// **신고한 사람에게 그 자리에서 답한다** (2026-08-20 사용자 지시).
//
// 지금까지 운영자가 이용자에게 먼저 말하는 길은 전체 공지 하나뿐이었다. 그런데 말을
// 걸어야 하는 상대는 대개 한 사람이고, 그 사람이 누구인지 가장 또렷한 자리가 바로
// **그 사람이 쓴 글 위**다. 목록으로 돌아가 이름을 다시 찾게 하면 그 일은 안 하게 된다.
//
// ── 폼을 따로 띄우지 않는다 ────────────────────────────────────
// 처음엔 제목·본문·미리보기가 있는 작성 판을 펼쳤는데, **여기서 나가는 쪽지는 언제나
// 같은 이유로 나간다** — "당신이 남긴 신고를 우리가 봤다". 그러면 매번 새로 지을 것은
// 사연 한 문단뿐이고, 제목 칸은 같은 말을 다시 쓰게 만드는 빈칸일 뿐이다.
// 제목은 고정하고(ABUSE_REPLY_TITLE), 쓰는 자리는 **누른 그 상자 안**에 둔다.
//
// 공지와 **같은 규칙**을 탄다 — 같은 금지 어휘 검사, 같은 길이, 같은 보낸 기록.
// 한 사람에게 가는 말이라고 더 느슨하지 않다: 1:1일수록 투자자문으로 읽힐 여지가 크다.
export function DirectMessage({
  userId,
  name,
  quote,
  action = "답장",
  title = ABUSE_REPLY_TITLE,
}: {
  userId: string;
  name: string;
  quote: string;
  /**
   * 고정 제목 — 자리마다 다르다 (2026-08-20 사용자 확정).
   * 신고 건이면 `리포트 신고 접수 안내`, 검수 반려면 `리포트 게시가 반려되었습니다`.
   * **제목은 그대로 푸시 문구**라, 받는 사람이 열기 전에 무슨 일인지 알아야 한다.
   */
  title?: string;
  /**
   * 펼쳤을 때 머리줄의 동사 — 신고자에게는 `답장`(그 사람이 먼저 썼다),
   * 리서처에게는 `알림`(우리가 먼저 건다). 같은 상자라도 **누가 먼저 말했는지**가
   * 다르면 같은 말이 아니다
   */
  action?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);

  // **금지 어휘는 보내기 전에 화면에서 걸린다** — 서버가 최종 방어선이지만, 눌러 보고
  // 거절당하는 것보다 쓰는 중에 아는 편이 문장을 고치기 쉽다
  const check = checkNoticeText(title, body);
  const len = body.trim().length;
  const ready = check.ok;
  const missing = !check.ok
    ? len < NOTICE_BODY_MIN
      ? `${NOTICE_BODY_MIN}자 이상 적어 주세요`
      : (check.reason ?? "내용을 확인해 주세요")
    : "";

  async function send() {
    if (!ready) {
      setError(missing);
      return;
    }
    if (!window.confirm(`${name} 님에게 보냅니다 — 보낸 뒤에는 회수할 수 없습니다.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/notices/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, title, body: body.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "보내지 못했습니다");
      setSentAt(new Date().toLocaleString("ko-KR"));
      setBody("");
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "보내지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  // 닫혀 있을 때 — 신고 내용 그 자체가 문이다
  if (!open) {
    return (
      <>
        <button
          type="button"
          className={`${a.quote} ${a.quoteMsg}`}
          onClick={() => setOpen(true)}
          // 버튼에 적힌 글자는 **신고 유형**이라 누르면 무슨 일이 생기는지를 말하지
          // 않는다. 화면에는 꼬리표를 안 달되(같은 말이 사람 수만큼 반복된다)
          // 낭독기에는 남긴다 — 눈으로 hover를 못 보는 쪽에는 이것이 유일한 단서다
          aria-label={`${name} 님에게 쪽지 보내기`}
        >
          {quote}
        </button>
        {sentAt && (
          <p className={a.hint} style={{ color: "var(--pos)", fontWeight: 700 }}>
            {name} 님에게 보냈습니다 · {sentAt}
          </p>
        )}
      </>
    );
  }

  // 펼쳤을 때 — **검색바와 같은 꼴**: 알약 하나에 쓰고, 옆의 동그란 단추로 보낸다.
  // 상자를 새로 띄우지 않는 것이 이 화면의 요구였다(2026-08-20 사용자 지시).
  return (
    <>
      {/* 누구에게 답하는지 — 테두리 없는 한 줄. 이것까지 상자로 만들면 상자가 셋이 된다.
          **사람 이름으로 적는다**: 닫혀 있을 때의 그 줄이 이제 인용문이 아니라 신고
          유형이라(“…를 썼어요”), 그걸 그대로 받아 “…에 답장”이라고 쓰면 유형에
          답장하는 것처럼 읽힌다. 답장은 언제나 사람에게 간다 */}
      <div className={a.replyTo}>
        <b>{name}</b>
        {` 님에게 ${action} · 제목은 `}
        {title}로 고정됩니다
      </div>
      <div className={a.replyRow}>
        <div className={a.replyForm}>
          <textarea
            className={a.replyInput}
            rows={1}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              // 검색바처럼 쓴 만큼만 자란다 — 빈 줄을 미리 벌려 두지 않는다
              e.currentTarget.style.height = "auto";
              e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // 쓰던 쪽지만 접는다 — 이 목록이 확인 창(AbuseGroupResolve) 안에서도
                // 열리는데, 그대로 위로 흘려보내면 Escape 한 번에 **창까지 함께
                // 닫혀** 방금 쓰던 글이 사라진다
                e.stopPropagation();
                setOpen(false);
              }
            }}
            placeholder={`${name} 님에게 보낼 말`}
            maxLength={NOTICE_BODY_MAX}
            aria-label={`${name} 님에게 보낼 말`}
            autoFocus
          />
        </div>
        <button
          type="button"
          className={a.replySend}
          onClick={send}
          disabled={busy || !ready}
          aria-label={`${name} 님에게 보내기`}
          title={ready ? "보내기" : missing}
        >
          {busy ? "…" : "↑"}
        </button>
      </div>

      {missing && <div className={a.gate}>{missing}</div>}
      {error && <p className={a.error}>{error}</p>}
    </>
  );
}
