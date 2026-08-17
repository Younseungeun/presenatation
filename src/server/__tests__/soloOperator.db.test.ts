import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { hashCi } from '../authService';
import {
  consumeOperatorRecheck,
  isSoloOperatorMode,
  issueOperatorRecheck,
  OPERATOR_RECHECK_WINDOW_MS,
} from '../operatorApprovalService';
import { freezePayouts, unfreezePayouts } from '../payoutAccountService';

// 1인 운영 모드 (2026-08-17 사용자 확정) — **두 번째 사람 자리를 생체가 대신한다.**
//
// 사업 초기 운영자는 창업자 1명뿐이고, 그때 2인 승인은 내부자(코드·DB를 쥔 본인)를
// 못 막으면서 본인만 막는 절차다. 그렇다고 관문을 없애면 계정 탈취(세션·기기를 훔친
// 외부자)까지 열린다 — 그래서 실행 직전 지문·얼굴 재확인이 선다:
//   세션만 훔친 사람 → 생체가 없어 못 한다 / 폰을 주운 사람 → 얼굴·지문이 없어 못 한다
// 이 파일이 지키는 성질:
//   ① 재확인 없이 실행하면 멈춘다 (요청도 안 올라간다 — 승인할 사람이 없다)
//   ② 재확인은 1회용이다 — 한 번의 지문으로 두 실행이 나가면 안 된다
//   ③ 낡은 재확인은 안 쳐준다 (5분 창)
//   ④ 진짜 운영자가 2명이 되면 자동으로 2인 승인으로 돌아간다

let prisma: PrismaClient;
let operatorId: string;
let researcherUserId: string;
const NOW = new Date('2026-08-17T00:00:00Z');

/** 생체를 통과한 화면이 표를 받는 것과 같다 — 시각만 뒤로 밀어 낡은 표도 만든다 */
async function stampRecheck(at: Date): Promise<string> {
  const token = await issueOperatorRecheck(prisma, operatorId, at);
  return token;
}

beforeAll(async () => {
  prisma = createTestDb('solo-op-');
  operatorId = (
    await prisma.user.create({
      data: { email: 'solo-op@iv.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;
  researcherUserId = (
    await prisma.user.create({
      data: { email: 'r@solo.io', identityVerified: true, identityHash: hashCi('ci-solo-r') },
    })
  ).id;
  await freezePayouts(prisma, { researcherUserId, actor: researcherUserId, reason: '내가 안 바꿈' }, NOW);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('모드 판정', () => {
  it('진짜 운영자 1명이면 1인 모드다 — 콜드 계정은 머릿수에 안 든다', async () => {
    expect(await isSoloOperatorMode(prisma)).toBe(true);
    const cold = await prisma.user.create({
      data: { email: 'cold@solo.io', role: 'OPERATOR', operatorCold: true },
    });
    expect(await isSoloOperatorMode(prisma)).toBe(true); // 콜드는 사람이 아니라 기기다
    await prisma.user.delete({ where: { id: cold.id } });
  });
});

describe('생체 재확인이 두 번째 사람을 대신한다', () => {
  it('① 재확인 없이는 멈추고, 승인 요청도 올라가지 않는다 — 승인할 사람이 없다', async () => {
    await expect(
      unfreezePayouts(prisma, { researcherUserId, operatorUserId: operatorId, reason: '확인' }, NOW),
    ).rejects.toMatchObject({ code: 'RECHECK_REQUIRED' });
    expect(
      await prisma.operatorApproval.count({ where: { targetId: researcherUserId } }),
    ).toBe(0);
    // 동결도 그대로다
    const acct = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    expect(acct.frozenAt).not.toBeNull();
  });

  it('③ 낡은 재확인은 안 쳐준다 — 5분 전 지문은 지금의 확인이 아니다', async () => {
    const stale = await stampRecheck(new Date(NOW.getTime() - OPERATOR_RECHECK_WINDOW_MS - 1000));
    await expect(
      unfreezePayouts(
        prisma,
        { researcherUserId, operatorUserId: operatorId, reason: '확인', recheckToken: stale },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'RECHECK_REQUIRED' });
  });

  // **표가 없으면 통과 못 한다** — 이 시험이 없으면 "세션만 훔친 사람"이 창업자의
  // 재확인에 얹혀 가는 결함(2026-08-17 자체 발견)이 되돌아와도 아무도 모른다
  it('**표 없이는 못 지나간다** — 도장이 찍혀 있어도 마찬가지다', async () => {
    await stampRecheck(new Date(NOW.getTime() - 30_000)); // 창업자가 방금 지문을 댔다
    await expect(
      // 표를 못 받은 쪽(훔친 세션)이 같은 순간에 실행을 시도한다
      unfreezePayouts(prisma, { researcherUserId, operatorUserId: operatorId, reason: '확인' }, NOW),
    ).rejects.toMatchObject({ code: 'RECHECK_REQUIRED' });
  });

  it('엉뚱한 표도 안 통한다', async () => {
    await stampRecheck(new Date(NOW.getTime() - 30_000));
    await expect(
      unfreezePayouts(
        prisma,
        { researcherUserId, operatorUserId: operatorId, reason: '확인', recheckToken: 'made-up' },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'RECHECK_REQUIRED' });
  });

  it('방금 받은 표로는 그 자리에서 실행되고, ② 표는 쓰면서 사라진다', async () => {
    const token = await stampRecheck(new Date(NOW.getTime() - 30_000));
    await unfreezePayouts(
      prisma,
      {
        researcherUserId,
        operatorUserId: operatorId,
        reason: '유선 본인 확인 완료',
        recheckToken: token,
      },
      NOW,
    );
    const acct = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    expect(acct.frozenAt).toBeNull();
    // 표가 지워졌다 — 다음 실행은 다시 지문을 요구한다
    const op = await prisma.user.findUniqueOrThrow({ where: { id: operatorId } });
    expect(op.operatorRecheckAt).toBeNull();
    expect(op.operatorRecheckTokenHash).toBeNull();

    // ② 같은 표로 두 번째 실행은 나가지 않는다
    await freezePayouts(prisma, { researcherUserId, actor: researcherUserId }, NOW);
    await expect(
      unfreezePayouts(
        prisma,
        { researcherUserId, operatorUserId: operatorId, reason: '재확인', recheckToken: token },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'RECHECK_REQUIRED' });
  });
});

describe('④ 두 번째 진짜 운영자가 오면 2인 승인으로 돌아간다', () => {
  it('같은 실행이 이제 승인 요청을 올리고 멈춘다', async () => {
    await prisma.user.create({
      data: { email: 'second-op@iv.io', identityVerified: true, role: 'OPERATOR' },
    });
    expect(await isSoloOperatorMode(prisma)).toBe(false);

    // 방금 받은 표가 있어도 소용없다 — 이제 두 번째 **사람**이 필요하다
    const token = await stampRecheck(NOW);
    await expect(
      unfreezePayouts(
        prisma,
        { researcherUserId, operatorUserId: operatorId, reason: '확인', recheckToken: token },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_PENDING' });
    expect(
      await prisma.operatorApproval.count({
        where: { action: 'PAYOUT_UNFREEZE', targetId: researcherUserId, status: 'PENDING' },
      }),
    ).toBe(1);
  });
});

describe('재확인 소비 단독 성질', () => {
  it('표가 없으면 던진다', async () => {
    // ④ 시험이 발급하고 안 쓴 표가 남아 있다 — 지우고 잰다
    await prisma.user.update({
      where: { id: operatorId },
      data: { operatorRecheckAt: null, operatorRecheckTokenHash: null },
    });
    await expect(consumeOperatorRecheck(prisma, operatorId, undefined, NOW)).rejects.toThrow(
      /지문·얼굴/,
    );
  });
});
