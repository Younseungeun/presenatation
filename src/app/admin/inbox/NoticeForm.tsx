"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  NOTICE_AUDIENCE_LABEL,
  NOTICE_AUDIENCES,
  NOTICE_BODY_MAX,
  NOTICE_TITLE_MAX,
  checkNoticeText,
  type NoticeAudience,
} from "@/domain/notice";
import a from "../admin.module.css";

// 내가 먼저 말하기 — **관리자가 이용자에게 말을 거는 유일한 자리** (시안 v3 tk-say).
//
// 지금까지 알림은 전부 사건이 만들었다(판정·정산·문의 답변). 운영자가 스스로 꺼낼
// 말은 어디에도 없어서 점검·규칙 변경·판정 정지를 알릴 방법이 없었다.
//
// 시안이 셋으로 나눈 순서를 그대로 지킨다 — **누구에게 → 어디로 → 무엇을.**
// 이 순서인 이유: 받는 사람이 정해져야 몇 명인지 알고, 닿는 길이 정해져야
// "이 글이 실제로 도착하는가"를 알 수 있다. 글은 마지막에 쓴다.

/** 닿는 길 — **지금 있는 것과 없는 것을 같이 적는다.** 체크박스만 나열하면
    없는 길에도 체크가 되고, 보냈다고 믿은 채로 아무도 못 받는 일이 생긴다 */
const CHANNELS = [
  {
    key: "inapp",
    name: "인앱 알림함",
    tag: { label: "있음", tone: "mint" as const },
    desc: "유일하게 지금 되는 길입니다. 다만 앱을 열어야 봅니다 — 급한 소식에는 이것만으로 부족합니다.",
    on: true,
    live: true,
  },
  {
    key: "email",
    name: "이메일",
    tag: { label: "붙이면 됨", tone: "warn" as const },
    desc: "주소는 이미 가입 때 받아 두었습니다. 발송 코드만 없습니다 — 앱 밖으로 닿는 가장 싸고 확실한 길이라 제일 먼저 붙일 자리입니다.",
    on: false,
    live: false,
  },
  {
    key: "push",
    name: "푸시 알림",
    tag: { label: "홈 화면에 추가한 사람만", tone: "plain" as const },
    desc: "인앱 알림을 만들면 스윕이 주워서 보냅니다. 다만 웹앱이라 아이폰은 홈 화면에 추가해야 받습니다 — 전체에 닿는 길로는 못 씁니다.",
    on: true,
    live: true,
  },
  {
    key: "sms",
    name: "문자",
    tag: { label: "계약 전", tone: "plain" as const },
    desc: "돈이 묶인 사람에게 닿아야 할 때의 마지막 수단입니다. 계약이 먼저입니다.",
    on: false,
    live: false,
  },
] as const;

export function NoticeForm({ counts }: { counts: Record<NoticeAudience, number> }) {
  const router = useRouter();
  const [audience, setAudience] = useState<NoticeAudience | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const check = checkNoticeText(title, body);
  const to = audience ? counts[audience] : 0;
  const ready = audience !== null && check.ok && to > 0;
  const missing = !audience
    ? "누구에게 보낼지 먼저 골라 주세요"
    : to === 0
      ? "받을 사람이 없습니다"
      : !check.ok
        ? check.reason!
        : "";

  const submit = async () => {
    if (!ready || !audience) return;
    if (
      !window.confirm(
        `${NOTICE_AUDIENCE_LABEL[audience]} ${to}명에게 지금 보냅니다. 회수할 수 없습니다. 진행할까요?`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/notices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body: body.trim(), audience }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "보내지 못했습니다");
      setDone(`${json.recipients}명에게 보냈습니다`);
      setTitle("");
      setBody("");
      setAudience(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "보내지 못했습니다");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {/* ── 누구에게 ─────────────────────────────────────────── */}
      <div className={a.sec}>누구에게</div>
      <div className={a.card}>
        <div className={a.chips} style={{ marginTop: 0 }}>
          {NOTICE_AUDIENCES.map((v) => (
            <button
              key={v}
              type="button"
              className={`${a.pick} ${audience === v ? a.pickOn : ""}`}
              onClick={() => setAudience(audience === v ? null : v)}
            >
              {NOTICE_AUDIENCE_LABEL[v]}
            </button>
          ))}
        </div>
        <div className={a.sent}>
          <div className={a.sTag}>받는 사람</div>
          <div className={`${a.sV} ${audience ? "" : a.sVNone}`}>
            {audience ? `${to.toLocaleString()}명` : "범위를 고르면 몇 명인지 나타납니다"}
          </div>
        </div>
      </div>

      {/* ── 어디로 ───────────────────────────────────────────── */}
      <div className={a.sec}>
        어디로 <small>인앱은 항상, 나머지는 있는 것만</small>
      </div>
      <div className={a.card}>
        {CHANNELS.map((c) => (
          <label key={c.key} className={`${a.chan} ${c.live ? "" : a.chanDim}`}>
            <input type="checkbox" checked={c.on} disabled readOnly />
            <span className={a.chanBody}>
              <span className={a.chanName}>
                {c.name}
                <span
                  className={`${a.chip} ${
                    c.tag.tone === "mint" ? a.chipMint : c.tag.tone === "warn" ? a.chipWarn : ""
                  }`}
                >
                  {c.tag.label}
                </span>
              </span>
              <span className={a.chanDesc}>{c.desc}</span>
            </span>
          </label>
        ))}
      </div>

      {/* ── 무엇을 ───────────────────────────────────────────── */}
      <div className={a.sec}>무엇을</div>
      <div className={a.card}>
        <input
          className={a.input}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="제목 — 알림함에 이 줄만 보입니다"
          aria-label="공지 제목"
          maxLength={NOTICE_TITLE_MAX}
        />
        <textarea
          className={a.textarea}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="본문"
          aria-label="공지 본문"
          maxLength={NOTICE_BODY_MAX}
        />

        <div className={`${a.note} ${a.noteNeg}`}>
          이 글도 <b>검수를 지납니다.</b> 플랫폼 이름으로 나가는 글이라 여기서 &ldquo;지금이
          매수 시점&rdquo; 같은 한 줄이 새면 <b>플랫폼이 직접 투자를 권유한 것</b>이 됩니다 —
          리서처 리포트보다 무거운 사고입니다.
        </div>

        <div className={a.prev}>
          <div className={a.prevH}>이용자에게 이렇게 보입니다</div>
          {title.trim() || body.trim() ? (
            <>
              <div className={a.prevT}>{title.trim() || "—"}</div>
              <div className={a.prevB}>{body.trim()}</div>
            </>
          ) : (
            <div className={a.prevNone}>제목과 본문을 쓰면 여기 나타납니다</div>
          )}
        </div>

        <div className={a.btnrow}>
          <button
            type="button"
            className={`${a.btn} ${ready && !busy ? a.btnInk : a.btnLine}`}
            disabled={!ready || busy}
            onClick={submit}
          >
            {busy
              ? "보내는 중…"
              : audience
                ? `${to.toLocaleString()}명에게 보내기`
                : "공지 보내기"}
            <span className={a.fp}>🔒</span>
          </button>
        </div>

        {missing && <div className={a.gate}>{missing}</div>}
        {error && <p className={a.error}>{error}</p>}
        {done && (
          <p className={a.hint} style={{ color: "var(--pos)", fontWeight: 700 }}>
            {done}
          </p>
        )}
      </div>
    </>
  );
}
