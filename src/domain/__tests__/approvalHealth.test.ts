import { describe, expect, it } from 'vitest';
import {
  assessApprovalHealth,
  BATCH_CLICK_MIN_COUNT,
  INSTANT_MIN_DECIDED,
  ZERO_REJECT_MIN_DECIDED,
  type ApprovalDecisionRow,
} from '../approvalHealth';

// 2인 승인의 사망 원인은 우회가 아니라 습관화다 — 이 파일은 그 감지기를 고정한다.
// 신호가 셋인 이유(굿하트 방어)는 domain/approvalHealth.ts 머리 주석에 있다.

const T0 = new Date('2026-08-16T00:00:00Z').getTime();

function row(over: Partial<ApprovalDecisionRow> & { decidedOffsetSec: number }): ApprovalDecisionRow {
  return {
    requestedAt: new Date(T0),
    decidedAt: new Date(T0 + over.decidedOffsetSec * 1000),
    decidedBy: over.decidedBy ?? 'op-b',
    status: over.status ?? 'APPROVED',
  };
}

describe('① 즉시 승인 비율', () => {
  it('표본이 작으면 비율이 높아도 경고하지 않는다 — 2~3건으로 비율을 말하면 오도다', () => {
    const rows = Array.from({ length: INSTANT_MIN_DECIDED - 1 }, () => row({ decidedOffsetSec: 5 }));
    expect(assessApprovalHealth(rows).instantAlert).toBe(false);
  });

  it('표본이 차고 절반 넘게 1분 미만이면 경고한다', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row({ decidedOffsetSec: 5, decidedBy: `op-${i}` })),
      ...Array.from({ length: 4 }, (_, i) => row({ decidedOffsetSec: 600, decidedBy: `slow-${i}` })),
    ];
    const h = assessApprovalHealth(rows);
    expect(h.instant).toBe(6);
    expect(h.instantAlert).toBe(true);
  });
});

describe('② 반려율 0% 지속', () => {
  it('표본 50건 위에서 반려가 하나도 없으면 검토가 아니라 도장이다', () => {
    const rows = Array.from({ length: ZERO_REJECT_MIN_DECIDED }, (_, i) =>
      row({ decidedOffsetSec: 3600 + i * 3600, decidedBy: `op-${i}` }),
    );
    expect(assessApprovalHealth(rows).zeroRejectAlert).toBe(true);
    // 반려가 하나라도 있으면 — 읽고 있다는 증거라 — 경고가 꺼진다
    const withReject = [...rows.slice(0, -1), row({ decidedOffsetSec: 3600, status: 'REJECTED' })];
    expect(assessApprovalHealth(withReject).zeroRejectAlert).toBe(false);
  });
});

describe('③ 연쇄 승인 — 10초 안에 3건은 본문을 읽지 않았다는 증거다', () => {
  it('같은 승인자의 10초 내 3건을 잡는다', () => {
    const rows = [
      row({ decidedOffsetSec: 3600 }),
      row({ decidedOffsetSec: 3603 }),
      row({ decidedOffsetSec: 3608 }),
    ];
    const h = assessApprovalHealth(rows);
    expect(h.batchRuns).toBe(1);
    expect(h.batchClickAlert).toBe(true);
  });

  it('서로 다른 승인자가 같은 시각에 각자 처리한 것은 연쇄가 아니다', () => {
    const rows = ['a', 'b', 'c'].map((who) => row({ decidedOffsetSec: 3600, decidedBy: who }));
    expect(assessApprovalHealth(rows).batchRuns).toBe(0);
  });

  it('반려는 연쇄에서 뺀다 — 반려는 읽었다는 증거 쪽이다', () => {
    const rows = [
      row({ decidedOffsetSec: 3600 }),
      row({ decidedOffsetSec: 3603, status: 'REJECTED' }),
      row({ decidedOffsetSec: 3608 }),
    ];
    expect(assessApprovalHealth(rows).batchRuns).toBe(0);
  });

  it(`${BATCH_CLICK_MIN_COUNT - 1}건까지는 연쇄가 아니다 — 정상 운영자도 두 건은 이어 본다`, () => {
    const rows = [row({ decidedOffsetSec: 3600 }), row({ decidedOffsetSec: 3605 })];
    expect(assessApprovalHealth(rows).batchRuns).toBe(0);
  });
});

describe('종합', () => {
  it('신호가 하나라도 켜지면 경고다 — 셋을 동시에 속이려면 실제로 읽는 수밖에 없다', () => {
    const healthy = [
      row({ decidedOffsetSec: 3600 }),
      row({ decidedOffsetSec: 7200, status: 'REJECTED' }),
    ];
    expect(assessApprovalHealth(healthy).alert).toBe(false);
    expect(assessApprovalHealth([]).alert).toBe(false);
  });
});
