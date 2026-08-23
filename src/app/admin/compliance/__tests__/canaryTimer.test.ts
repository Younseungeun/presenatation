import { describe, expect, it } from 'vitest';
import { countdownBand } from '../canaryTimer';

/**
 * **정말로 늦었을 때 색이 오르는가** (2026-08-23 창업자 확인 요구).
 *
 * 타이머가 이유 없이 노랑·빨강으로 오르던 버그를 고쳤는데, 고치는 방향이 "값을 새로
 * 읽는다"였다. 그러자 정당한 물음이 따라왔다 — **억지로 회색이 되는 것 아니냐.**
 * 그 답은 말이 아니라 이 시험이다: 아래 표는 색이 오르는 조건을 그대로 못 박는다.
 *
 * 앞선 버그는 이 함수가 아니라 **입력**이 낡아서 났다(화면이 연 순간의 `nextAt` 을
 * 계속 들고 있었다). 함수는 그때도 옳았고 지금도 같다.
 */

const MIN = 60_000;
const BAND = 5 * MIN; // 주기 = 칸 크기
const NEXT = new Date('2026-08-23T12:00:00.000Z');
const at = (offsetMs: number) => NEXT.getTime() + offsetMs;

describe('countdownBand — 밀린 만큼 색이 오른다', () => {
  it('예정 시각 전이면 0칸(회색) — 다음 점검까지 남은 시간을 센다', () => {
    expect(countdownBand(NEXT, at(-3 * MIN), BAND)).toEqual({ band: 0, text: '3:00' });
    expect(countdownBand(NEXT, at(-1_000), BAND).band).toBe(0);
  });

  it('**예정 시각을 넘기는 순간 1칸(노랑)** — 늦은 것은 늦었다고 말한다', () => {
    expect(countdownBand(NEXT, at(1), BAND).band).toBe(1);
    expect(countdownBand(NEXT, at(2 * MIN), BAND)).toEqual({ band: 1, text: '3:00' });
  });

  it('한 주기를 더 넘기면 2칸(빨강) — 다음은 ✗ 다', () => {
    expect(countdownBand(NEXT, at(BAND), BAND).band).toBe(2);
    expect(countdownBand(NEXT, at(BAND + 2 * MIN), BAND)).toEqual({ band: 2, text: '3:00' });
  });

  it('2칸을 넘겨도 더 오르지 않는다 — 그 위는 색이 아니라 `✗` 의 몫이다', () => {
    expect(countdownBand(NEXT, at(10 * BAND), BAND).band).toBe(2);
    expect(countdownBand(NEXT, at(10 * BAND), BAND).text).toBe('0:00');
  });

  it('**칸 경계가 곧 문턱이다** — 3칸이 끝나는 지점 = 주기 × 3 (CANARY_STALE_MS)', () => {
    // 마지막 칸이 0:00 이 되는 순간이 정확히 예정 시각 + 주기 × 2 = 박동 기준 문턱
    const endOfLastBand = at(2 * BAND);
    expect(countdownBand(NEXT, endOfLastBand, BAND).text).toBe('0:00');
  });

  it('점검이 제때 돌면 칸이 되돌아간다 — 새 `nextAt` 이 오면 다시 0칸', () => {
    const late = countdownBand(NEXT, at(1 * MIN), BAND);
    expect(late.band).toBe(1);
    // 스케줄러가 돌아 예정 시각을 한 주기 앞으로 밀었다
    const fresh = countdownBand(new Date(at(BAND)), at(1 * MIN), BAND);
    expect(fresh.band).toBe(0);
  });

  it('주기를 바꾸면 눈금이 따라 움직인다 — 값이 두 곳에 박혀 있지 않다', () => {
    const tenMin = 10 * MIN;
    // 5분 주기에서는 1칸이던 지점이 10분 주기에서는 아직 0칸이다
    expect(countdownBand(NEXT, at(-6 * MIN), BAND).band).toBe(0);
    expect(countdownBand(NEXT, at(6 * MIN), BAND).band).toBe(2);
    expect(countdownBand(NEXT, at(6 * MIN), tenMin).band).toBe(1);
  });
});
