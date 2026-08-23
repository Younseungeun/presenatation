import { describe, expect, it } from 'vitest';
import {
  ABUSE_SUSPEND_REPORTERS,
  ABUSE_SUSPENDED_MESSAGE,
  suspendsOnAbuseReports,
} from '../abuseSuspension';

// 신고 누적에 의한 가역적 판매 중단 — 문턱의 성질만 고정한다.
// **막는 것은 "한 사람의 말로 남의 판매가 멈추는 일"이다.** 그 성질이 상수 하나에
// 걸려 있으므로, 값이 바뀌면 시험이 먼저 말하게 해 둔다.

describe('판매를 멈추는 신고자 수', () => {
  it('문턱 아래에서는 아무것도 멈추지 않는다', () => {
    expect(suspendsOnAbuseReports(0)).toBe(false);
    expect(suspendsOnAbuseReports(1)).toBe(false);
    expect(suspendsOnAbuseReports(2)).toBe(false);
  });

  it('문턱에 닿으면 멈춘다', () => {
    expect(suspendsOnAbuseReports(ABUSE_SUSPEND_REPORTERS)).toBe(true);
    expect(suspendsOnAbuseReports(ABUSE_SUSPEND_REPORTERS + 5)).toBe(true);
  });

  // **이 시험이 지키는 것이 설계의 핵심이다.** 문턱이 1이 되는 순간 신고 버튼은
  // 무기가 된다 — 공짜로 누를 수 있고, 잃은 판매 기간은 복구 장치가 없다.
  it('한 사람의 신고로는 절대 멈추지 않는다', () => {
    expect(ABUSE_SUSPEND_REPORTERS).toBeGreaterThan(1);
    expect(suspendsOnAbuseReports(1)).toBe(false);
  });

  // 하루 신고 한도가 3이라, 한 사람이 같은 리포트를 3번 신고할 수 있으면 혼자서
  // 문턱에 닿는다. 그 구멍은 "서로 다른 신고자"로 세는 것 + DB 유니크 제약이 막고,
  // 여기서는 문턱이 그 한도보다 낮지 않다는 것만 확인한다
  it('문턱이 1인 하루 신고 한도보다 낮지 않다', () => {
    expect(ABUSE_SUSPEND_REPORTERS).toBeGreaterThanOrEqual(2);
  });
});

describe('구매자에게 보이는 문구', () => {
  // 확인되지 않은 혐의를 시장에 방송하면 안 된다 — 기각되면 남는 것은 방송된 혐의뿐이다
  it('신고를 사유로 밝히지 않는다', () => {
    expect(ABUSE_SUSPENDED_MESSAGE).not.toMatch(/신고/);
  });

  // "마감"으로 읽히면 다시 팔릴 리포트를 끝난 것으로 오해한다
  it('되돌아올 수 있다는 것을 말한다', () => {
    expect(ABUSE_SUSPENDED_MESSAGE).toMatch(/일시 중단|다시 구매/);
  });
});
