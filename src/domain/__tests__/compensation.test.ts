import { describe, expect, it } from 'vitest';
import {
  causeFromDataSource,
  compensationAmountKrw,
  isCompensable,
} from '../compensation';
import { settle } from '../settlement';

// 플랫폼 귀책 보상의 순수 규칙.
//
// 이 파일이 지키는 것은 **금액과 대상**이다. 나머지(누가 확정하나, 언제 나가나)는
// 서버 쪽 시험의 몫이고, 여기서 갈라지면 돈이 조용히 틀린 값으로 나간다.

describe('보상액', () => {
  // **전액이면 장애가 정상 적중보다 이득이 된다** — 수수료를 안 떼기 때문이다.
  // 그 역유인이 남으면 언젠가 누군가 그것을 노린다
  it('판매 대금에서 수수료를 뺀 금액이다 — 적중했을 때와 정확히 같다', () => {
    const amountKrw = 10_000;
    const feeRateBp = 2_000; // 20%
    const hit = settle({ amountKrw, feeRateBp, prepaymentRatio: 0, outcome: 'HIT' });
    expect(compensationAmountKrw({ amountKrw, feeRateBp })).toBe(hit.researcherPayoutKrw);
    expect(compensationAmountKrw({ amountKrw, feeRateBp })).toBe(8_000);
  });

  // 반올림 규칙이 갈라지면 원 단위로 조용히 쌓인다 — 그래서 settle을 그대로 부른다
  it('반올림까지 정산 공식을 따른다', () => {
    for (const amountKrw of [3_333, 7_777, 12_345, 49_999]) {
      for (const feeRateBp of [1_000, 1_300, 1_500, 2_000]) {
        expect(compensationAmountKrw({ amountKrw, feeRateBp })).toBe(
          settle({ amountKrw, feeRateBp, prepaymentRatio: 0, outcome: 'HIT' }).researcherPayoutKrw,
        );
      }
    }
  });

  // **선결제분은 이미 Settlement이 준다.** 여기서 또 세면 그만큼 두 번 나간다
  it('선결제 비율에 흔들리지 않는다', () => {
    const base = compensationAmountKrw({ amountKrw: 10_000, feeRateBp: 2_000 });
    for (const prepaymentRatio of [0, 10, 20, 30]) {
      const hit = settle({
        amountKrw: 10_000,
        feeRateBp: 2_000,
        prepaymentRatio,
        outcome: 'HIT',
      });
      expect(hit.researcherPayoutKrw).toBe(base);
    }
  });
});

describe('귀책 판별', () => {
  it('하드캡 경로 넷만 보상 대상이다', () => {
    expect(causeFromDataSource('hard-cap:paused')).toBe('SYSTEM_PAUSE');
    expect(causeFromDataSource('hard-cap:manual-only')).toBe('MANUAL_QUEUE');
    expect(causeFromDataSource('hard-cap:error')).toBe('SYSTEM_ERROR');
    expect(causeFromDataSource('hard-cap')).toBe('DATA_UNKNOWN');
  });

  // **정상 판정에 보상이 붙으면 안 된다.** 상장폐지·강제 철회도 판정 불가지만
  // 우리 탓이 아니다 — 결과(UNDECIDABLE)가 아니라 사유로 가르는 이유가 이것이다
  it('정상 판정과 우리 탓이 아닌 판정 불가에는 붙지 않는다', () => {
    for (const src of ['upbit', 'kis', 'manual:op-1', 'stooq', 'twelvedata', '']) {
      expect(causeFromDataSource(src)).toBeNull();
    }
  });

  // 접두사로 맞추면 새 사유가 뭉치에 섞여 조용히 통과한다 — 빠져서 눈에 띄는 편이 낫다
  it('모르는 하드캡 사유는 통과시키지 않고 null로 남긴다', () => {
    expect(causeFromDataSource('hard-cap:something-new')).toBeNull();
  });
});

describe('대상 구매', () => {
  it('판정 불가 환불로 닫힌 정상 구매와 아직 갈리기 전 구매만 대상이다', () => {
    expect(isCompensable({ escrowStatus: 'HELD', amountKrw: 10_000 })).toBe(true);
    expect(isCompensable({ escrowStatus: 'REFUNDED', amountKrw: 10_000 })).toBe(true);
  });

  // 차지백(DISPUTED)·CS 무효화(CANCELLED)는 **판매가 일어났다는 전제 자체**가 깨진 건이다.
  // 그 돈은 애초에 우리에게 없거나 거래가 없던 것이 됐다
  it('차지백·거래 무효화 건은 뺀다', () => {
    expect(isCompensable({ escrowStatus: 'DISPUTED', amountKrw: 10_000 })).toBe(false);
    expect(isCompensable({ escrowStatus: 'CANCELLED', amountKrw: 10_000 })).toBe(false);
  });

  it('금액이 없는 구매는 대상이 아니다', () => {
    expect(isCompensable({ escrowStatus: 'HELD', amountKrw: 0 })).toBe(false);
  });
});
