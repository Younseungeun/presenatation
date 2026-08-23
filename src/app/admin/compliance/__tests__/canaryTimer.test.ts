import { describe, expect, it } from 'vitest';
import { countdownBand } from '../canaryTimer';

/**
 * **정말로 늦었을 때 색이 오르는가** (2026-08-23 창업자 확인 요구).
 *
 * 타이머가 이유 없이 색을 올리던 버그를 고쳤는데, 고치는 방향이 "값을 새로 읽는다"였다.
 * 그러자 정당한 물음이 따라왔다 — **억지로 회색이 되는 것 아니냐.** 그 답은 말이 아니라
 * 이 시험이다: 아래 표가 색이 오르는 조건을 그대로 못 박는다.
 *
 * 앞선 버그는 이 함수가 아니라 **입력**이 낡아서 났다(화면이 연 순간의 `nextAt` 을
 * 계속 들고 있었다). 함수는 그때도 옳았고 지금도 같다.
 */

const MIN = 60_000;
const BAND = 5 * MIN; // 주기 = 칸 크기
const STALE = 2 * BAND; // 문턱 = 주기 × 2 → 칸 둘 (회색 · 빨강)
const NEXT = new Date('2026-08-23T12:00:00.000Z');
const at = (offsetMs: number) => NEXT.getTime() + offsetMs;

describe('countdownBand — 밀린 만큼 색이 오른다', () => {
  it('예정 시각 전이면 0칸(회색) — 다음 점검까지 남은 시간을 센다', () => {
    expect(countdownBand(NEXT, at(-3 * MIN), BAND, STALE)).toMatchObject({
      band: 0,
      tone: 'ok',
      text: '3:00',
    });
    expect(countdownBand(NEXT, at(-1_000), BAND, STALE).tone).toBe('ok');
  });

  it('**예정 시각을 넘기는 순간 색이 오른다** — 늦은 것은 늦었다고 말한다', () => {
    expect(countdownBand(NEXT, at(1), BAND, STALE).band).toBe(1);
    expect(countdownBand(NEXT, at(2 * MIN), BAND, STALE)).toMatchObject({
      band: 1,
      tone: 'bad',
      text: '3:00',
    });
  });

  it('마지막 칸을 넘겨도 더 오르지 않는다 — 그 위는 색이 아니라 `✗` 의 몫이다', () => {
    const far = countdownBand(NEXT, at(10 * BAND), BAND, STALE);
    expect(far).toMatchObject({ band: 1, tone: 'bad', text: '0:00' });
  });

  it('**칸 경계가 곧 문턱이다** — 마지막 칸이 0:00 이 되는 지점 = 박동 기준 문턱', () => {
    expect(countdownBand(NEXT, at(STALE - BAND), BAND, STALE).text).toBe('0:00');
  });

  it('점검이 제때 돌면 칸이 되돌아간다 — 새 `nextAt` 이 오면 다시 0칸', () => {
    expect(countdownBand(NEXT, at(1 * MIN), BAND, STALE).band).toBe(1);
    // 스케줄러가 돌아 예정 시각을 한 주기 앞으로 밀었다
    const fresh = countdownBand(new Date(at(BAND)), at(1 * MIN), BAND, STALE);
    expect(fresh).toMatchObject({ band: 0, tone: 'ok' });
  });

  it('**칸 수는 문턱에서 나온다** — 박아 두면 문턱을 바꿀 때 마지막 칸이 문턱 너머를 센다', () => {
    // 문턱 3배(옛 값)면 칸이 셋 — 가운데는 노랑, 마지막만 빨강
    const wide = 3 * BAND;
    expect(countdownBand(NEXT, at(1 * MIN), BAND, wide).tone).toBe('warn');
    expect(countdownBand(NEXT, at(BAND + MIN), BAND, wide).tone).toBe('bad');
    // 같은 시점이라도 문턱이 2배면 이미 마지막 칸이라 빨강이다
    expect(countdownBand(NEXT, at(1 * MIN), BAND, STALE).tone).toBe('bad');
  });

  it('주기를 바꾸면 눈금이 따라 움직인다 — 값이 두 곳에 박혀 있지 않다', () => {
    const ten = 10 * MIN;
    // 5분 주기에서는 이미 넘긴 지점이 10분 주기에서는 아직 첫 칸이다
    expect(countdownBand(NEXT, at(6 * MIN), BAND, STALE).band).toBe(1);
    expect(countdownBand(NEXT, at(-6 * MIN), ten, 2 * ten).band).toBe(0);
  });
});
