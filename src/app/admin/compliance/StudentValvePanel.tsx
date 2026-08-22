"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { WhyBody, WhyGroup, WhyToggle } from "../Why";
import a from "../admin.module.css";
import s from "./irisStatus.module.css";

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
     * **파일이 들고 온 이름** (회신 14호 §3) — `config.json` 의 `name`.
     * `.env` 태그는 첫 `/health` 이전의 폴백일 뿐이라, 이 값이 있으면 이쪽이 진실이다.
     * 사이드카가 답하지 않으면 null — 그때는 도장의 이름(폴백)만 남는다.
     *
     * ⚠ **`run` 과 헷갈리면 안 된다.** 하루 동안 이 자리에 `run` 을 그렸는데, 그것은
     * 이름이 아니라 **회차 기록 문장**이라("r5 (풍문·연락처 대비쌍 160 추가) — 채택·라이브")
     * 화면에 문장이 통째로 떴다. 회신 14호가 칸을 나눈 이유가 정확히 이것이다.
     */
    name?: string | null;
    /** 회차 기록 문장 — 대장과 같은 값. **이름 자리에 쓰지 않는다** */
    run?: string | null;
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

/**
 * **검수 규칙의 한 줄 요약** — IRIS 바로 아래, 같은 위상 (2026-08-23 창업자 지시).
 *
 * 검수하는 것이 둘(규칙 엔진 · IRIS)인데 화면에서는 멀리 떨어져 있었다. 한 상자에
 * 나란히 놓으면 "지금 검수가 돌고 있나"에 한 눈으로 답이 나온다.
 *
 * ── 빨간불의 기준은 **문제를 풀어서 틀렸을 때만** (창업자 확정) ──
 * 층 여섯 개 문항 중 하나라도 틀리면 비정상이다. `heartbeatStale`(자동 점검이 안 도는
 * 것)은 **여기에 넣지 않는다** — 그건 "규칙이 고장났나"가 아니라 "지켜보는 사람이
 * 있나"라 축이 다르고, 섞으면 규칙이 멀쩡한 날에도 빨간불이 켜져 신호가 죽는다.
 * 그 사실은 `자동 점검 ✓/✗` 가 옆에서 따로 말한다.
 *
 * ── 화면이 잰 값에는 유효기간이 있다 (창업자 지적) ──
 * 점은 화면을 **연 순간** 카나리아를 돌려 나온 값이라 켜 두면 그때 그대로 멈춘다 —
 * 14:00 에 열고 14:02 에 규칙이 죽으면 14:30 에도 초록이었다. 30분째 거짓말이고,
 * 하필 계기판에서 가장 신뢰받는 자리다. 그래서 늙으면 **초록을 내린다.**
 * 빨강으로 바꾸지 않는 것이 중요하다 — 깨졌다는 근거가 없고 **모른다**는 뜻이라
 * 회색(`dotIdle`)이 맞는 답이고, 빨강이면 없는 사고를 쫓게 된다.
 *
 * ── 눈금(주기·문턱)은 서버가 준다 ──
 * 여기서 `screeningCanaryRunner` 의 상수를 import 하면 그 모듈이 통째로 브라우저
 * 번들에 딸려 들어간다(prisma·node:fs 를 끌고 온다). **tsc 는 통과하고 번들러만
 * 터진다** — 실제로 한 번 터뜨려 확인했다. 서버 페이지가 숫자만 넘긴다.
 */

/**
 * **초 단위로 도는 시계** — 이 줄에만 둔다.
 *
 * 패널 전체의 `now` 는 30초마다 움직이는데, 초가 흐르는 타이머를 그러려면 패널이
 * 통째로 초마다 다시 그려진다. 훅을 이 컴포넌트 안에 두면 다시 그려지는 것은
 * 이 한 줄뿐이다. 그릴 것이 없으면(`active === false`) 시계도 돌지 않는다.
 */
function useTicker(active: boolean): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setT(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [active]);
  return t;
}

/**
 * **밀린 만큼 색이 오른다** (2026-08-23 창업자 지시).
 *
 * 자동 점검은 5분마다 돌아야 하는데 `✗` 는 15분이 지나야 뜬다. 그 사이 10분은
 * 예전에는 `✓` 하나로 덮여 있어서 **한 번 걸렀는지 두 번 걸렀는지 알 수 없었다** —
 * 문턱이 넉넉한 것과 그 동안 아무 말도 안 하는 것은 다른 문제다.
 *
 * 그래서 5분짜리 칸 셋으로 나눈다. 각 칸은 자기 몫의 5분을 세고, 넘어갈 때마다
 * 색이 오른다. 셋째 칸이 끝나는 지점이 정확히 `CANARY_STALE_MS`(= 주기 × 3)라
 * **눈금과 문턱이 어긋날 수 없다** — 15분이 다른 값이 되면 칸도 같이 움직인다.
 *
 *   0~5분   회색   제때 돌고 있다 — 다음 점검까지 남은 시간
 *   5~10분  노랑   한 번 걸렀다
 *   10~15분 빨강   두 번 걸렀다 — 다음은 ✗
 */
function countdownBand(
  nextAt: Date,
  nowMs: number,
  bandMs: number,
): { band: 0 | 1 | 2; text: string } {
  const over = nowMs - nextAt.getTime();
  const band = (over < 0 ? 0 : Math.min(2, Math.floor(over / bandMs) + 1)) as 0 | 1 | 2;
  const remain = Math.max(0, nextAt.getTime() + band * bandMs - nowMs);
  const total = Math.ceil(remain / 1_000);
  return {
    band,
    text: `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`,
  };
}

const TIMER_TONE = [s.timerOk, s.timerWarn, s.timerBad] as const;

/** 색만으로는 "왜 노랗지"에 답이 없다 — 무엇을 세고 있는지 글로도 남긴다 */
const TIMER_HINT = [
  "다음 자동 점검까지 남은 시간입니다.",
  "예정 시각을 한 번 넘겼습니다 — 이 시간이 지나면 빨간색이 됩니다.",
  "예정 시각을 두 번 넘겼습니다 — 이 시간이 지나면 자동 점검이 ✗ 로 바뀝니다.",
] as const;

function RuleRow({
  failures,
  heartbeatStale,
  nowMs,
  measuredAt,
  nextAt,
  freshMs,
  staleMs,
  schedulerOff,
}: {
  failures: { layer: string }[];
  heartbeatStale: boolean;
  nowMs: number;
  /** 카나리아 주기 — 화면이 잰 값의 유효기간과 같다 */
  freshMs: number;
  /** 자동 점검이 이만큼 성공하지 않으면 ✗ (스케줄러의 CANARY_STALE_MS) */
  staleMs: number;
  /** 스케줄러 자체가 멎어 있는가 — 그러면 자동 점검 표시를 아예 그리지 않는다 */
  schedulerOff: boolean;
  /** 이 화면이 카나리아를 돌린 시각 — 서버 렌더 시점 */
  measuredAt: number;
  /**
   * 다음 점검 예정 시각 — **스케줄러가 직접 써 준다**(`screening.canary.nextAt`).
   *
   * 예전에는 이 화면이 '매시 정각'을 스스로 계산했는데, 주기가 5분으로 바뀌자 곧바로
   * "다음 59분 뒤"라고 거짓말했다. 주기를 아는 곳이 둘이면 갈라지고, 갈라져도 아무
   * 시험이 잡지 못한다(회신 15호 ③-1). 이제 주기를 아는 곳은 스케줄러 하나다.
   */
  nextAt: Date | null;
}) {
  const broken = failures.length > 0;
  const ageMin = Math.floor((nowMs - measuredAt) / 60_000);
  /* 이미 틀린 것을 봤으면 늙었다고 흐리지 않는다 — 실패는 확인된 사실이고,
     시간이 지난다고 사라지지 않는다. 흐려도 되는 것은 '통과' 쪽뿐이다 */
  const measurementStale = !broken && nowMs - measuredAt > freshMs;
  const tick = useTicker(!heartbeatStale && !!nextAt);
  /* 멈춰 있으면(`✗`) 타이머를 그리지 않는다 — 오지 않을 약속이고, 기다리면 해결된다고
     읽혀 고치러 가지 않게 만든다. 예정 시각을 못 받았을 때도 마찬가지로 비운다:
     주기를 여기서 짐작해 채우면 예전의 "다음 59분 뒤" 거짓말이 되돌아온다 */
  const timer = heartbeatStale || !nextAt ? null : countdownBand(nextAt, tick, freshMs);
  return (
    <div className={s.ruleRow}>
      {broken ? (
        <span className={s.alert} aria-hidden="true">
          !
        </span>
      ) : (
        <span
          className={`${s.dot} ${measurementStale ? s.dotIdle : ""}`}
          aria-hidden="true"
        />
      )}
      <span className={s.ruleName}>검수 규칙</span>
      {/* 늙은 값이면 **언제 잰 것인지**를 적는다. 회색 점만으로는 "꺼졌나"로도 읽혀서,
          숫자가 있어야 "새로고침하면 된다"가 전달된다 */}
      {measurementStale && (
        <span className={s.due} title="이 화면이 잰 값입니다 — 새로고침하면 다시 잽니다">
          {ageMin}분 전 측정
        </span>
      )}
      {/* **IRIS 의 `IRIS.v5 ✓` 와 같은 자리** — 이름 옆에서 "그게 참인가"를 말하는 값.
          다만 여기서 참인 것은 이름이 아니라 **누가 지켜보고 있나**다.
          점을 물들이지 않는 이유(창업자 확정): 규칙이 멀쩡한 날에도 빨간불이 켜지면
          신호가 죽는다. 그래서 작고 흐리게, 다만 멈췄을 때는 주의색으로 보이게 */}
      {/* **스케줄러가 꺼져 있으면 이 줄을 통째로 그리지 않는다** (2026-08-23 창업자 지시).
          자동 점검이 안 도는 것은 그때 당연한 결과라 `✗` 가 새 사실을 하나도 더하지
          않는다. 그 고장은 **스케줄러 ON/OFF 표시가 이미 2분 안에** 말하고 있고,
          한 고장을 두 곳에서 증상으로 띄우면 운영자가 원인을 두 번 쫓는다.
          꺼진 줄 모르고 볼 때만 이 자리가 필요한데, 그때는 저쪽이 먼저 답한다.
          반대로 **스케줄러는 살아 있는데 이 점검만 안 도는 경우**가 이 표시의
          존재 이유 전부다 — 그건 저쪽 표시로 절대 보이지 않는다 */}
      {schedulerOff ? null : (
      <span
        className={s.name}
        title={
          heartbeatStale
            ? `자동 점검이 ${Math.round(staleMs / 60_000)}분 넘게 성공하지 않았습니다 — 스케줄러를 확인하세요`
            : "자동 점검이 최근에 통과했습니다"
        }
      >
        자동 점검{" "}
        {heartbeatStale ? (
          <span className={s.stale}>✗</span>
        ) : (
          <span className={s.ok}>✓</span>
        )}
        {timer && (
          <span
            className={`${s.timer} ${TIMER_TONE[timer.band]}`}
            title={TIMER_HINT[timer.band]}
          >
            {timer.text}
          </span>
        )}
      </span>
      )}
      {/* **무엇이 틀렸는지를 이름으로 적는다** — "1건 실패"는 어디를 봐야 할지
          알려주지 않는다. 층 이름이 곧 고칠 자리다 */}
      {broken &&
        failures.map((f) => (
          <span key={f.layer} className={`${a.chip} ${a.chipNeg}`}>
            {f.layer}
          </span>
        ))}
    </div>
  );
}

export function StudentValvePanel({
  canaryFailures = [],
  heartbeatStale = false,
  measuredAt,
  canaryNextAt = null,
  canaryIntervalMs,
  canaryStaleMs,
  schedulerOff = false,
}: {
  canaryFailures?: { layer: string }[];
  /** 카나리아 주기 (스케줄러 `CANARY_INTERVAL_MS`) — 화면이 잰 값의 유효기간을 겸한다 */
  canaryIntervalMs: number;
  /** 자동 점검 ✗ 문턱 (스케줄러 `CANARY_STALE_MS`) — 안내 문구에만 쓴다 */
  canaryStaleMs: number;
  /** 스케줄러 심박이 낡았는가(= OFF). 그러면 자동 점검 표시를 걷는다 */
  schedulerOff?: boolean;
  /** 자동 점검이 문턱(CANARY_STALE_MS) 넘게 성공하지 않았는가 — 점은 물들이지 않고 ✓/✗ 로만 */
  heartbeatStale?: boolean;
  /** `canaryFailures` 를 잰 시각(서버 렌더 시점) — 없으면 늙지 않는 값으로 본다 */
  measuredAt?: number;
  /** 스케줄러가 적어 둔 다음 점검 예정 시각 — 없으면 남은 시간을 적지 않는다 */
  canaryNextAt?: Date | null;
}) {
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
          position: "relative",
          ...(tone === "warn" ? { borderLeft: "4px solid #c4303b" } : {}),
        }}
      >
        <div className={a.row}>
          {/* **박스 전체가 상세로 가는 문이다** (창업자 지시). 도장·지문·회차 기록은
              지운 것이 아니라 `/admin/compliance/iris` 로 옮겼다 — 되짚을 때만 필요한
              값이라 매일 보는 화면에서 자리를 차지할 이유가 없다.
              링크의 가짜 요소가 카드를 덮고, 밸브 버튼만 그 위로 올라온다 */}
          <Link href="/admin/compliance/iris" className={s.head}>
            {/* **상태는 글자가 아니라 형태로 말한다.** 배지("근무 중")는 읽어야 하고
                읽는 동안 다른 글자와 경쟁한다 — 상태는 곁눈질로 잡혀야 하는 값이다.
                이상은 색만 바꾸지 않고 **모양을 바꾼다**: 색각 이상·흑백 화면에서도
                초록 점과 빨간 느낌표는 구별되지만 초록 점과 빨간 점은 같아 보인다 */}
            {tone === "warn" ? (
              <span className={s.alert} aria-hidden="true">
                !
              </span>
            ) : (
              <span
                className={`${s.dot} ${tone === "ok" ? "" : s.dotIdle}`}
                aria-hidden="true"
              />
            )}
            <span className={a.ttl} style={{ display: "inline" }}>
              IRIS
            </span>
            {/* 이름과 대조 결과는 제목 옆에 붙는다 — "지금 누가 근무 중인가"가 한 줄로
                읽히고, ✓ 는 그 이름이 참인지를 말하므로 이름에서 떨어지면 안 된다 */}
            {student.reviewerId && (
              <span className={s.name}>
                {student.name ?? student.reviewerId}
                {student.promotionMatches === true && (
                  <>
                    {" "}
                    <span className={s.ok} title="적재 지문이 승격 기록과 일치합니다">
                      ✓
                    </span>
                  </>
                )}
              </span>
            )}
            {/* 상태 글자는 정상일 때 지웠지만 **이상일 때는 남긴다** — 그때는 읽어야 한다 */}
            {tone !== "ok" && <span className={a.chip}>{label}</span>}
            <span className={s.name} aria-hidden="true">
              ›
            </span>
          </Link>
          <span className={`${a.rowTags} ${s.above}`}>
            {tone === "warn" && board.outageSince && (
              <span className={`${a.chip} ${a.chipNeg}`}>{elapsed(board.outageSince, now)}</span>
            )}
            {tone === "warn" && (
              <span className={`${a.chip} ${board.outageHolds > 0 ? a.chipWarn : ""}`}>
                보류 {board.outageHolds}건
              </span>
            )}
            {/* 도움말은 카드 우측 상단 — 상태가 왼쪽 신호등으로 옮겨 가며 비운 자리다 */}
            <WhyToggle />
          </span>
        </div>

        {/* **검수하는 것이 둘이다** — 규칙 엔진과 IRIS. 화면에서 멀리 떨어져 있던 둘을
            한 상자에 같은 위상으로 놓는다 (창업자 지시). "지금 검수가 돌고 있나"에
            한 눈으로 답이 나와야 하고, 그 답은 두 줄이다 */}
        <RuleRow
          failures={canaryFailures}
          heartbeatStale={heartbeatStale}
          nowMs={now}
          measuredAt={measuredAt ?? now}
          nextAt={canaryNextAt}
          freshMs={canaryIntervalMs}
          staleMs={canaryStaleMs}
          schedulerOff={schedulerOff}
        />

        {/* **지문은 어긋날 때만 펼친다.** 일치하면 제목 옆 ✓ 가 이미 결론이라
            8자리를 매일 읽을 이유가 없다 — 화재경보기는 있어야 하지만 평소에 숫자를
            보고 있을 필요는 없다. 대조는 계속 돈다, 숫자만 안 보일 뿐이다.
            사이드카가 답하지 않으면 침묵하지 않는다 — 빈자리는 "안 바뀌었다"로 읽힌다 */}
        {student.reviewerId && student.promotionMatches !== true && (
          <div className={a.meta}>
            {student.modelSha ? (
              <>
                <span>적재 지문</span>
                <code style={{ fontSize: 11.5 }}>{student.modelSha.slice(0, SHA_PREFIX)}</code>
              </>
            ) : (
              <span>적재 지문 — 사이드카가 답하지 않습니다</span>
            )}
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
          <div className={s.above} style={{ display: "flex", gap: 8, marginTop: 10 }}>
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
