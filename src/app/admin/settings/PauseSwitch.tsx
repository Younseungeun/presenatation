"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import a from "../admin.module.css";

// 자동 판정 정지 스위치.
//
// **다른 스위치와 다르게 사유를 묻는다.** 나머지 설정은 "보여줄지 말지"라 되돌리기가
// 쉽지만, 이건 멈춘 동안 판정이 밀리고 밀린 판정은 이월 상한(14일)에 닿으면 전액
// 환불로 끝난다. 왜 멈췄는지 모르면 **언제 풀어야 하는지도 모른다.**
//
// **정지는 화면에 두고 롤백은 CLI에 둔다.** 성격이 반대이기 때문이다 —
// 정지는 보호적이라 남이 눌러도 손해가 "판정이 늦어짐"이고 사고 때 가장 빨리 눌러야
// 하는 것이지만, 일괄 롤백은 파괴적이라 세션 하나가 하루치 판정을 날릴 수 있다.
// TOTP가 붙기 전까지 파괴적 행위는 셸 접근을 요구하는 자리에 둔다.
//
// 사유는 **화면 안에서 받는다** (2026-08-19). 예전에는 window.prompt를 띄웠는데,
// 브라우저 대화상자는 ① 무엇을 켜려는지 화면에서 사라진 채 묻고 ② 취소와 빈 입력이
// 구별되지 않으며 ③ 감사 로그로 가는 글을 다시 읽어볼 수 없다. 사유가 로그의
// 전부인 자리라 쓰는 자리도 화면이어야 한다.
export function PauseSwitch({
  scope,
  label,
  initial,
}: {
  scope: string;
  label: string;
  initial: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = useState(initial);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = !on;
  const ready = reason.trim().length >= 2;

  async function commit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/judgment-pause", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scope, paused: next, reason: reason.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "저장하지 못했습니다");
      setOn(next);
      setAsking(false);
      setReason("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    // 멈춰 있는 것은 붉은 띠 — 판정이 밀리는 중이고 밀린 판정은 상한에 닿으면
    // 전액 환불로 끝난다. 목록에서 곁눈질로도 잡혀야 한다
    <div className={`${a.card} ${on ? a.stripeNeg : ""}`}>
      <div className={a.swRow}>
        <div className={a.swMain}>
          <div className={a.ttl}>
            {label}
            {on && <span className={`${a.chip} ${a.chipNeg}`}>정지 중</span>}
          </div>
          <p className={a.hint}>
            {on
              ? "판정·도달 판정 배치가 이 범위를 건드리지 않습니다. 시세를 직접 확인한 뒤 여세요 — 자동 해제는 없습니다."
              : "정상 동작 중입니다."}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label={`${label} 자동 판정 정지`}
          className={`${a.sw} ${on ? a.swOn : ""}`}
          onClick={() => {
            setAsking((v) => !v);
            setError(null);
          }}
          disabled={busy}
        >
          <span className={a.knob} />
        </button>
      </div>

      {asking && (
        <div className={a.branch}>
          <div className={a.lbl}>
            {next ? "멈추는 이유" : "다시 여는 이유"}
            <small>감사 로그에 그대로 남습니다</small>
          </div>
          <div className={a.field}>
            <input
              className={a.input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                next
                  ? "예: 공급자가 8/19 종가를 0으로 주고 있음"
                  : "예: 공급자 값 정상 복구 확인 (8/19 종가 재조회)"
              }
              aria-label="사유"
              maxLength={300}
              autoFocus
            />
          </div>
          {!next && (
            <p className={a.hint}>
              여는 것은 <strong>시세가 정상이라는 판단</strong>입니다 — 직접 확인하셨나요?
            </p>
          )}
          {/* 잉크 = 지금 누를 수 있다. 사유가 차기 전에는 회색이다 */}
          <div className={a.btnrow}>
            <button
              type="button"
              className={`${a.btn} ${a.btnGhost}`}
              onClick={() => {
                setAsking(false);
                setReason("");
              }}
              disabled={busy}
            >
              그만두기
            </button>
            <button
              type="button"
              className={`${a.btn} ${ready && !busy ? a.btnInk : a.btnLine}`}
              disabled={!ready || busy}
              onClick={commit}
            >
              {busy ? "저장 중…" : next ? "자동 판정 멈추기" : "자동 판정 다시 열기"}
            </button>
          </div>
          {!ready && <div className={a.gate}>사유를 적어야 바꿀 수 있습니다</div>}
          {error && <p className={a.error}>{error}</p>}
        </div>
      )}
    </div>
  );
}
