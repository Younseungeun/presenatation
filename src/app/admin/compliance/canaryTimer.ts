/**
 * **감시 타이머 — 밀린 만큼 색이 오른다** (2026-08-23 창업자 지시).
 *
 * 점검은 주기(5분)마다 돌아야 하는데 `✗` 는 문턱(10분 = 주기 × 2)이 지나야 뜬다.
 * 그 사이가 `✓` 하나로 덮여 있으면 **한 번 걸렀는지 두 번 걸렀는지 알 수 없다** —
 * 문턱이 넉넉한 것과 그동안 아무 말도 안 하는 것은 다른 문제다.
 *
 * 그래서 주기 크기의 칸으로 나눈다. 각 칸은 자기 몫의 시간을 세고, 넘어갈 때마다
 * 색이 오른다. 지금 눈금(주기 5분 · 문턱 10분)에서는:
 *
 *   0~5분    회색   제때 돌고 있다 — 다음 점검까지 남은 시간
 *   5~10분   빨강   한 번 걸렀다 — 다음은 ✗
 *
 * ── 칸 수를 박지 않는다 ────────────────────────────────────────
 * 칸 수는 `문턱 ÷ 주기` 로 **계산한다.** 3으로 박아 두었다가 문턱이 15분에서 10분으로
 * 내려가자 마지막 칸이 문턱 너머를 세게 됐다 — 화면이 `✗` 가 뜬 뒤에도 카운트다운을
 * 계속하는 모양이다. 눈금과 문턱이 **한 값에서 나와야** 그런 어긋남이 생기지 않는다.
 *
 * ── 색은 마지막 칸만 빨강 ──────────────────────────────────────
 * 마지막 칸은 "다음은 ✗"라 빨강이 정직하다. 칸이 셋 이상이 되면 그 사이는 노랑으로
 * 채운다 — 문턱을 다시 늘려도 색 사다리가 저절로 맞는다.
 *
 * ── 화면 컴포넌트에서 떼어낸 이유 ────────────────────────────
 * 이 함수가 **정말로 늦었을 때 색을 올리는지**를 시험이 붙잡아야 한다. 값이 낡아서
 * 색이 오르던 버그를 고치는 과정에서 "그럼 억지로 회색이 되는 것 아니냐"는 물음이
 * 나왔고, 그 물음의 답은 말이 아니라 시험이어야 한다.
 */
export interface CountdownBand {
  /** 0 = 제때 · 1 이상 = 그만큼 걸렀다. 마지막 칸이 문턱 직전이다 */
  band: number;
  /** 그 칸의 색 — `ok`(회색) · `warn`(노랑) · `bad`(빨강) */
  tone: "ok" | "warn" | "bad";
  /** `m:ss` — 이 칸이 끝나기까지 */
  text: string;
}

export function countdownBand(
  nextAt: Date,
  nowMs: number,
  bandMs: number,
  staleMs: number,
): CountdownBand {
  // 칸 수 = 문턱 ÷ 주기. 마지막 칸이 끝나는 지점이 곧 `✗` 가 뜨는 지점이다
  const bands = Math.max(1, Math.round(staleMs / bandMs));
  const over = nowMs - nextAt.getTime();
  const band = over < 0 ? 0 : Math.min(bands - 1, Math.floor(over / bandMs) + 1);
  const remain = Math.max(0, nextAt.getTime() + band * bandMs - nowMs);
  const total = Math.ceil(remain / 1_000);
  return {
    band,
    tone: band === 0 ? "ok" : band === bands - 1 ? "bad" : "warn",
    text: `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`,
  };
}
