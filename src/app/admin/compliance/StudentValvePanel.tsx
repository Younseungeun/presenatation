"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { WhyBody, WhyGroup, WhyToggle } from "../Why";
import a from "../admin.module.css";

// **IRIS 출근 상태** (인계 3호 · 2026-08-21 밤).
//
// ── 문구는 비유를 따른다 (창업자 확정 멘탈 모델) ────────────────
//   IRIS   = 직원 본인
//   사이드카     = 그 직원이 출근해 앉는 창구
//   usable 검사  = 출근 확인 (자리에 있고 전화를 받는가 + 실제로 문제를 푸는가)
//   밸브         = 창구가 닫혔을 때의 2시간짜리 임시 통로
//
// "사이드카 헬스체크" 같은 말을 쓰지 않는다. 운영자에게는 기술 용어보다 이쪽이 정확하다.
//
// ── 왜 API 에서 직접 읽는가 ─────────────────────────────────────
// `getStudentOutageBoard` 에는 `student`(근무 여부·판정기 표식)가 없고 라우트에만 있다.
// 화면이 서버에서 따로 `studentMode()` + `usable()` 를 계산하면 **같은 질문의 답이
// 두 곳에서 나오고**, 언젠가 갈라진다 — 카나리아 층 하드코딩(2회차 A-2)과 같은 모양이다.
// 라우트가 계약의 원천이므로 거기서만 읽는다.
//
// ── 왜 정상일 때도 그리는가 ─────────────────────────────────────
// 앞선 판(장애 때만 표시)을 인계 3호가 뒤집었다. 이건 경고가 아니라 **계기판**이다 —
// "지금 누가 근무 중인가"가 상시로 보여야 `reviewerId` 가 바뀌는 날(모델 교체·라벨 추가)을
// 운영자가 눈으로 알아챈다. 그것이 이 표식의 존재 이유 중 하나다.

interface Board {
  outageSince: string | null;
  outageHolds: number;
  bypass: { active: boolean; until: string | null };
  student: {
    mode: "live" | "shadow" | "off";
    reviewerId: string | null;
    usable: boolean;
    /** 못 쓸 때만 채워진다 — 쓸 수 있는데 사유를 적으면 그 줄이 배경음이 된다 */
    unavailableReason?: string | null;
    /**
     * 사이드카가 **실제로 적재한** 가중치의 지문 (3회차 B-1 → 회신 3호 (가) 채택).
     *
     * `reviewerId` 는 설정(태그·임계값)에서 조립되므로 "무엇을 쓰겠다고 설정했나"까지만
     * 말한다. 재학습으로 가중치만 갈리면 표식은 한 글자도 안 움직인다 — 실제로
     * 2026-08-21 하루에 모델이 세 번 갈리는 동안 표식이 그대로였다.
     */
    modelSha: string | null;
    /**
     * 마지막 승격 기록 (회신 8호 §3). `student:promote` 가 지문 대조를 통과한 뒤에만
     * 쓴다 — 기록이 먼저 생기므로 재기동이 실패하면 "기록은 새 지문, 라이브는 옛 지문"이
     * 되고, 그 어긋남이 곧 신호다.
     */
    promoted: { sha: string; at: string } | null;
    /**
     * 적재 지문 === 승격 지문.
     *
     * **false 는 경고가 아니라 사고다** — 승격 명령이 라이브에 오르는 유일한 경로이므로,
     * 그것 없이 지문이 바뀌었다는 것은 기각본이 재기동으로 올라왔다는 뜻이다.
     * null 은 비교할 값이 없는 것(승격 이력 없음 또는 사이드카 무응답)이라 사고가 아니다.
     */
    promotionMatches: boolean | null;
  };
}

/** 지문은 앞 8자면 충분하다 — 같은지 다른지만 눈으로 가르면 된다 */
const SHA_PREFIX = 8;

/** 하루 넘게 결근이면 사람이 확인할 자리를 알려 준다 — 화면은 OS 작업을 볼 수 없다 */
const SCHEDULER_HINT_MS = 24 * 60 * 60_000;

function elapsed(since: string | null, now: number): string | null {
  if (!since) return null;
  const min = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
  if (min < 60) return `${min}분째`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `${hours}시간째` : `${Math.floor(hours / 24)}일째`;
}

/** 밸브는 시한폭탄이라 **남은 시간**이 곧 정보다 (HH:MM) */
function countdown(until: string | null, now: number): string | null {
  if (!until) return null;
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return null;
  const total = Math.floor(ms / 60_000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

type Tone = "ok" | "warn" | "neutral";

export function StudentValvePanel() {
  const router = useRouter();
  const [board, setBoard] = useState<Board | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  // **가져오기와 넣기를 나눈다** — 조회 함수가 상태까지 건드리면 효과 안에서
  // 부르는 순간 동기 setState 로 읽혀(cascading render) 린트가 막는다.
  // 값만 돌려주면 넣는 자리를 부르는 쪽이 정한다
  const fetchBoard = useCallback(async (): Promise<Board | null> => {
    try {
      const res = await fetch("/api/admin/compliance/student-valve");
      return res.ok ? ((await res.json()) as Board) : null;
    } catch {
      // 계기판을 못 읽는 것은 사건이 아니라 결측이다 — 화면을 죽이지 않는다
      return null;
    }
  }, []);

  useEffect(() => {
    // 떠난 화면에 값을 넣지 않는다 — 응답이 늦게 오는 동안 탭이 바뀔 수 있다
    let alive = true;
    void (async () => {
      const next = await fetchBoard();
      if (alive && next) setBoard(next);
    })();
    return () => {
      alive = false;
    };
  }, [fetchBoard]);

  // 분 단위 표시라 30초면 충분하다. 밸브 만료를 화면이 스스로 알아채는 것도 이 주기다
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!board) return null;

  const { student, bypass } = board;
  const left = bypass.active ? countdown(bypass.until, now) : null;
  const bypassing = bypass.active && left !== null;
  const outageMs = board.outageSince ? now - new Date(board.outageSince).getTime() : 0;

  // ── 다섯 상태 (인계 3호 §2) ───────────────────────────────────
  let label: string;
  let tone: Tone;
  if (student.mode === "off") {
    label = "미출근 (꺼짐) — 규칙 단독 검수";
    tone = "neutral";
  } else if (student.mode === "shadow") {
    label = "연수 중 (그림자) — 판정하되 기록만";
    tone = "neutral";
  } else if (student.usable) {
    label = "근무 중";
    tone = "ok";
  } else if (bypassing) {
    label = `결근 · 우회 중 — ${left} 뒤 자동 복귀`;
    tone = "warn";
  } else {
    label = "결근";
    tone = "warn";
  }

  async function send(action: "engage" | "release") {
    setBusy(true);
    setFailed(null);
    try {
      const res = await fetch("/api/admin/compliance/student-valve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setFailed(body?.error ?? "처리하지 못했습니다.");
        return;
      }
      const next = await fetchBoard();
      if (next) setBoard(next);
      // 보류 건수는 서버 렌더 목록에도 걸려 있어 함께 새로 그린다
      router.refresh();
    } catch {
      setFailed("서버에 닿지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <WhyGroup>
      <div
        className={a.card}
        style={{
          marginBottom: 14,
          ...(tone === "warn" ? { borderLeft: "4px solid #c4303b" } : {}),
        }}
      >
        <div className={a.row}>
          <div className={a.ttl}>
            IRIS 출근 상태
            <WhyToggle />
          </div>
          <span className={a.rowTags}>
            {/* **근무 중은 무채색이다** — 민트는 플랫폼 검증 전용이라 여기 쓰면
                "이 판정기를 우리가 보증한다"로 읽힌다 (브랜드 §4-3) */}
            <span className={`${a.chip} ${tone === "warn" ? a.chipNeg : ""}`}>{label}</span>
            {tone === "warn" && board.outageSince && (
              <span className={`${a.chip} ${a.chipNeg}`}>{elapsed(board.outageSince, now)}</span>
            )}
            {tone === "warn" && (
              <span className={`${a.chip} ${board.outageHolds > 0 ? a.chipWarn : ""}`}>
                보류 {board.outageHolds}건
              </span>
            )}
          </span>
        </div>

        {/* **표식은 자르지 않는다** — `모델태그@t임계값/L라벨수` 라 L7 이 L8 로 바뀌는 날
            (라벨 추가) 운영자가 눈으로 알아채는 것이 이 값의 존재 이유 중 하나다 */}
        {student.reviewerId && (
          <div className={a.meta}>
            <span>근무자 표식</span>
            <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{student.reviewerId}</code>
            {/* **표식과 지문은 다른 질문에 답한다** — 표식은 "무엇을 쓰기로 했나",
                지문은 "지금 실제로 무엇이 올라가 있나". 표식이 그대로인데 지문이
                바뀌었다면 재학습으로 가중치만 갈린 것이고, 그날을 운영자가 눈으로
                알아채는 유일한 자리가 여기다 */}
            {student.modelSha ? (
              <>
                <span>적재 지문</span>
                <code style={{ fontSize: 11.5 }}>{student.modelSha.slice(0, SHA_PREFIX)}</code>
              </>
            ) : (
              // 지문이 없으면 침묵하지 않는다 — 빈자리는 "안 바뀌었다"로 읽힌다
              <span>적재 지문 — 사이드카가 답하지 않습니다</span>
            )}
            {/* **지문만으로는 사고를 못 알아본다** (회신 8호 §3). 화면이 현재 값만 그리면
                "바뀌었다"를 알려면 사람이 어제 값을 기억해야 하는데, 실제로 하루에 세 번
                갈린 날 아무도 못 알아챘다(그중 승격은 하나뿐이었다).
                승격 기록과 대조해야 비로소 화면이 그날 말할 수 있다 */}
            {student.promotionMatches === true && <span>✓ 승격 기록과 일치</span>}
          </div>
        )}

        {/* **일치하지 않으면 경고가 아니라 사고다** — 승격 명령이 라이브에 오르는 유일한
            경로이므로, 그것 없이 지문이 바뀌었다는 것은 기각본이 재기동으로 올라왔다는
            뜻이다. 그래서 색이 주의(노랑)가 아니라 위험(빨강)이다 */}
        {student.promotionMatches === false && (
          <div className={`${a.note} ${a.noteNeg}`}>
            <b>승격 기록에 없는 지문입니다 — 재기동으로 올라온 것일 수 있습니다.</b>{" "}
            승격 명령이 라이브에 오르는 유일한 경로이므로, 지금 돌고 있는 모델은{" "}
            <b>채택되지 않은 것일 수 있습니다.</b>
            {student.promoted && (
              <>
                <br />
                마지막 승격 <code>{student.promoted.sha.slice(0, SHA_PREFIX)}</code> ·{" "}
                {new Date(student.promoted.at).toLocaleString("ko-KR")} — 지금 적재된 것은{" "}
                <code>{student.modelSha?.slice(0, SHA_PREFIX)}</code> 입니다.
              </>
            )}
          </div>
        )}

        {tone === "warn" && !bypassing && (
          <div className={`${a.note} ${a.noteNeg}`}>
            창구가 닫혀 있어 <b>게시가 전부 보류되고 있습니다.</b> 창구를 다시 여는 것이
            정답이고, 그때까지 큐가 감당이 안 되면 아래 임시 통로를 열 수 있습니다 —
            <b>통로가 열린 동안에는 규칙만 보고 게시됩니다.</b>
            {/* **왜 닫혔는지가 여기 있어야 한다.** 사유는 장애 알림으로도 나가지만 그건
                상태가 **바뀌는 순간** 한 번뿐이고, 고치러 오는 사람이 보는 곳은 알림함이
                아니라 이 화면이다. 2026-08-22 에 토크나이저 지문이 갈렸을 때 화면에는
                "결근"만 있어서 사이드카를 직접 열어 봐야 원인을 알 수 있었다 */}
            {student.unavailableReason && (
              <>
                <br />
                <b>사유</b> — {student.unavailableReason}
              </>
            )}
          </div>
        )}

        {bypassing && (
          <div className={`${a.note} ${a.noteWarn}`}>
            <b>임시 통로 열림 · {left} 뒤 자동으로 닫힙니다</b> — 지금 올라오는 리포트는
            IRIS 검사 없이 규칙만 보고 게시됩니다. 닫힌 뒤에도 창구가 그대로면 다시 전부
            보류됩니다.
          </div>
        )}

        {/* 화면은 OS 작업을 직접 볼 수 없다 — **어디를 봐야 하는지까지**가 몫이다 */}
        {tone === "warn" && outageMs > SCHEDULER_HINT_MS && (
          <div className={`${a.note} ${a.noteWarn}`}>
            하루 넘게 결근입니다 — 자동 출근(작업 스케줄러{" "}
            <code>intovill-student-sidecar</code>)이 등록·실행 중인지 확인이 필요합니다.
          </div>
        )}

        {tone === "warn" && (
          // **재시작 버튼을 만들지 않는다** (인계 3호 §5) — 재기동은 OS(watchdog)의 몫이고,
          // 화면이 프로세스를 만지기 시작하면 장애 원인이 "누가 껐다 켰나"부터 불투명해진다
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button type="button" className={a.btn} disabled={busy} onClick={() => send("engage")}>
              {bypassing ? "2시간 더 열어 두기" : "임시 통로 열기 — 2시간"}
            </button>
            {bypassing && (
              <button
                type="button"
                className={`${a.btn} ${a.btnGhost}`}
                disabled={busy}
                onClick={() => send("release")}
              >
                지금 닫기
              </button>
            )}
          </div>
        )}

        {failed && <div className={`${a.note} ${a.noteNeg}`}>{failed}</div>}

        <WhyBody className={a.meta}>
          <span>
            <b>출근 확인</b>에는 실제 문제 풀이가 포함됩니다 — 자리에 앉아 전화를 받아도
            쉬운 위반 문장 하나를 못 풀면 결근으로 봅니다.
          </span>
          <span>
            <b>임시 통로</b>는 2시간 뒤 저절로 닫힙니다. 연장은 다시 여는 것이고, 그 클릭이
            &ldquo;아직 필요하다&rdquo;는 판단 기록입니다.
          </span>
          <span>
            채택 근거 수치(임계값·오탐·순이익)는 화면에 싣지 않습니다 — 재학습마다 바뀌어
            낡은 숫자가 남습니다. 전문은 <code>training/labeling/review-21.md</code> 부록 3.
          </span>
        </WhyBody>
      </div>
    </WhyGroup>
  );
}
