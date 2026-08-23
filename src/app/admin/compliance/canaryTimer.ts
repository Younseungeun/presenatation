/**
 * **자동 점검 타이머 — 밀린 만큼 색이 오른다** (2026-08-23 창업자 지시).
 *
 * 자동 점검은 주기(5분)마다 돌아야 하는데 `✗` 는 문턱(15분 = 주기 × 3)이 지나야 뜬다.
 * 그 사이 10분이 `✓` 하나로 덮여 있어 **한 번 걸렀는지 두 번 걸렀는지 알 수 없었다** —
 * 문턱이 넉넉한 것과 그동안 아무 말도 안 하는 것은 다른 문제다.
 *
 *   0~5분   회색   제때 돌고 있다 — 다음 점검까지 남은 시간
 *   5~10분  노랑   한 번 걸렀다
 *   10~15분 빨강   두 번 걸렀다 — 다음은 ✗
 *
 * 칸 크기가 주기이고 칸이 셋이라 **셋째 칸이 끝나는 지점이 정확히 문턱**이다. 눈금과
 * 문턱이 어긋날 수 없다 — 주기가 바뀌면 칸도 같이 움직인다.
 *
 * ── 화면 컴포넌트에서 떼어낸 이유 ────────────────────────────
 * 이 함수가 **정말로 늦었을 때 색을 올리는지**를 시험이 붙잡아야 한다. 값이 낡아서
 * 색이 오르던 버그를 고치는 과정에서 "그럼 억지로 회색이 되는 것 아니냐"는 물음이
 * 나왔고, 그 물음의 답은 말이 아니라 시험이어야 한다. `"use client"` 컴포넌트 안에
 * 두면 CSS 모듈까지 딸려 와 순수 함수 하나를 재기가 어렵다.
 */
export interface CountdownBand {
  /** 0 = 제때 · 1 = 한 번 걸름 · 2 = 두 번 걸름 */
  band: 0 | 1 | 2;
  /** `m:ss` — 이 칸이 끝나기까지 */
  text: string;
}

export function countdownBand(nextAt: Date, nowMs: number, bandMs: number): CountdownBand {
  const over = nowMs - nextAt.getTime();
  const band = (over < 0 ? 0 : Math.min(2, Math.floor(over / bandMs) + 1)) as 0 | 1 | 2;
  const remain = Math.max(0, nextAt.getTime() + band * bandMs - nowMs);
  const total = Math.ceil(remain / 1_000);
  return {
    band,
    text: `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`,
  };
}
