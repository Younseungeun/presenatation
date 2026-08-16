import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  canApprove,
  DUAL_APPROVAL_THRESHOLD_KRW,
  requiresDualApproval,
} from '@/domain/operatorApproval';
import {
  ApprovalError,
  consumeApproval,
  decideApproval,
  getPendingApprovals,
  requestApproval,
} from '../operatorApprovalService';

// 운영자 2인 승인 (Maker-Checker) — **접근 제어가 못 막는 것을 막는다.**
//
// 패스키와 최근성은 "들어오는 것"을 막는다. 그런데 운영자 계정 탈취의 피해는 들어온
// 뒤에 생기고, **악의를 품은 내부자는 정당하게 들어온다.** 둘 다 접근 제어로는 못 막고,
// 실행을 두 사람이 나누는 것만이 막는다.
//
// 이 파일이 지키는 성질:
//   ① 요청자는 자기 요청을 승인할 수 없다 — **이 한 줄이 2인 승인의 전부다**
//   ② 승인서는 1회용 — 한 번 승인으로 두 번 실행되면 돈이 두 번 나간다
//   ③ 승인 없이 실행하면 던진다
//   ④ 전부에 걸지는 않는다 — 소액까지 걸면 승인이 형식이 되고, 그때 장식이 된다

let prisma: PrismaClient;
const OP_A = 'operator-a';
const OP_B = 'operator-b';
const NOW = new Date('2026-08-16T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('approval-');
  // notifyOperators가 운영자를 찾는다
  await prisma.user.create({
    data: { email: 'op@ap.io', identityVerified: true, role: 'OPERATOR', identityHash: 'ap-op' },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('문턱 — 전부에 걸지는 않는다', () => {
  it('문턱 위만 2인 승인이다', () => {
    expect(requiresDualApproval(DUAL_APPROVAL_THRESHOLD_KRW)).toBe(true);
    expect(requiresDualApproval(DUAL_APPROVAL_THRESHOLD_KRW - 1)).toBe(false);
    // 카드 가격이 5천~5만원이라 일상적인 정산은 여기 안 걸린다.
    // 걸면 승인이 습관이 되고, 습관이 되는 순간 2인 승인은 장식이다
    expect(requiresDualApproval(300_000)).toBe(false);
  });
});

describe('**요청자는 자기 요청을 승인할 수 없다** — 이 규칙이 전부다', () => {
  it('순수 규칙이 그것을 막는다', () => {
    expect(canApprove({ requestedBy: OP_A, approverUserId: OP_A, status: 'PENDING' })).toEqual({
      ok: false,
      reason: expect.stringContaining('요청한 사람은 승인할 수 없습니다'),
    });
    expect(canApprove({ requestedBy: OP_A, approverUserId: OP_B, status: 'PENDING' })).toEqual({
      ok: true,
    });
  });

  it('이미 처리된 요청은 다시 승인되지 않는다', () => {
    expect(
      canApprove({ requestedBy: OP_A, approverUserId: OP_B, status: 'APPROVED' }),
    ).toMatchObject({ ok: false });
  });

  it('서비스에서도 같은 규칙이 걸린다', async () => {
    const { id } = await requestApproval(
      prisma,
      {
        action: 'PAYOUT_UNFREEZE',
        targetId: 'user-1',
        summary: '동결 해제',
        requestedBy: OP_A,
        reason: '본인 확인 완료',
      },
      NOW,
    );
    await expect(
      decideApproval(prisma, { approvalId: id, approverUserId: OP_A, approve: true }, NOW),
    ).rejects.toThrow(ApprovalError);
    await expect(
      decideApproval(prisma, { approvalId: id, approverUserId: OP_B, approve: true }, NOW),
    ).resolves.toBe('APPROVED');
  });
});

describe('승인서는 1회용', () => {
  it('승인 없이 실행하면 던진다', async () => {
    await expect(
      consumeApproval(prisma, { action: 'PAYOUT_UNFREEZE', targetId: 'no-approval' }, NOW),
    ).rejects.toThrow(/다른 운영자의 승인이 필요합니다/);
  });

  it('한 번 쓰면 두 번째는 막힌다 — 승인 하나로 돈이 두 번 나가면 안 된다', async () => {
    await consumeApproval(prisma, { action: 'PAYOUT_UNFREEZE', targetId: 'user-1' }, NOW);
    await expect(
      consumeApproval(prisma, { action: 'PAYOUT_UNFREEZE', targetId: 'user-1' }, NOW),
    ).rejects.toThrow(ApprovalError);
  });

  it('반려된 요청은 실행에 쓸 수 없다', async () => {
    const { id } = await requestApproval(
      prisma,
      {
        action: 'LARGE_PAYOUT',
        targetId: 'settlement-x',
        summary: '고액 지급',
        amountKrw: 9_000_000,
        requestedBy: OP_A,
        reason: '분기 정산',
      },
      NOW,
    );
    await decideApproval(
      prisma,
      { approvalId: id, approverUserId: OP_B, approve: false, note: '근거 부족' },
      NOW,
    );
    await expect(
      consumeApproval(prisma, { action: 'LARGE_PAYOUT', targetId: 'settlement-x' }, NOW),
    ).rejects.toThrow(ApprovalError);
  });
});

describe('요청', () => {
  it('사유 없이는 요청할 수 없다 — 승인자가 판단할 근거가 없다', async () => {
    await expect(
      requestApproval(
        prisma,
        { action: 'PAYOUT_UNFREEZE', targetId: 'user-2', summary: '해제', requestedBy: OP_A, reason: '  ' },
        NOW,
      ),
    ).rejects.toThrow(ApprovalError);
  });

  it('같은 대상에 중복 요청을 만들지 않는다 — 유령 승인서가 남는다', async () => {
    const first = await requestApproval(
      prisma,
      { action: 'PAYOUT_UNFREEZE', targetId: 'user-3', summary: '해제', requestedBy: OP_A, reason: '확인' },
      NOW,
    );
    const second = await requestApproval(
      prisma,
      { action: 'PAYOUT_UNFREEZE', targetId: 'user-3', summary: '해제', requestedBy: OP_B, reason: '확인' },
      NOW,
    );
    expect(second.id).toBe(first.id);
  });

  it('대기 목록에 오래된 순으로 쌓인다', async () => {
    const pending = await getPendingApprovals(prisma);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((p) => p.status === 'PENDING')).toBe(true);
  });
});
