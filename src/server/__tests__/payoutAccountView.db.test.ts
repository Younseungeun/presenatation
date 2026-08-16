import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  ACCOUNT_CHANGE_COOLDOWN_MS,
  freezePayouts,
  registerPayoutAccount,
} from '../payoutAccountService';
import { payoutAccountView } from '../payoutAccountView';

// 본인이 보는 정산 계좌 상태 — **동결 버튼이 놓인 화면의 데이터.**
//
// 이 파일이 지키는 것 셋:
//   ① 계좌번호는 어떤 경로로도 나가지 않는다 (뒤 4자리만)
//   ② 계좌 없이 미리 잠근 경우를 "등록됨"으로 세지 않는다 — 빈 행이 생기기 때문
//   ③ 동결은 멱등이다 — 급한 사람은 버튼을 두 번 누른다

let prisma: PrismaClient;
const NOW = new Date('2026-08-16T00:00:00Z');

beforeAll(async () => {
  prisma = createTestDb('payout-view-');
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeUser(email: string) {
  const u = await prisma.user.create({ data: { email, identityVerified: true } });
  return u.id;
}

describe('payoutAccountView — 본인이 보는 정산 계좌', () => {
  it('계좌가 없으면 비어 있다고 말한다', async () => {
    const v = await payoutAccountView(prisma, await makeUser('none@p.io'), NOW);
    expect(v.registered).toBe(false);
    expect(v.frozen).toBe(false);
    expect(v.last4).toBeNull();
  });

  it('**계좌번호 전체는 나가지 않는다** — 뒤 4자리만', async () => {
    const userId = await makeUser('reg@p.io');
    await registerPayoutAccount(
      prisma,
      { researcherUserId: userId, bankCode: '004', accountNumber: '1234567890', actor: userId },
      NOW,
    );
    const v = await payoutAccountView(prisma, userId, NOW);
    expect(v.registered).toBe(true);
    expect(v.last4).toBe('7890');
    // 화면이 필요한 것은 "내가 아는 그 계좌가 맞나"이지 번호 자체가 아니다.
    // 계정을 쥔 사람에게 전체 번호를 보여 주면 탈취가 그대로 정보 유출이 된다
    expect(JSON.stringify(v)).not.toContain('1234567890');
  });

  it('막 등록·변경한 계좌는 남은 유예 시간을 함께 보여준다', async () => {
    const userId = await makeUser('cool@p.io');
    await registerPayoutAccount(
      prisma,
      { researcherUserId: userId, bankCode: '004', accountNumber: '1111222233', actor: userId },
      NOW,
    );
    const soon = new Date(NOW.getTime() + ACCOUNT_CHANGE_COOLDOWN_MS / 2);
    expect(await payoutAccountView(prisma, userId, soon)).toMatchObject({
      cooldownHoursLeft: expect.any(Number),
    });
    const later = new Date(NOW.getTime() + ACCOUNT_CHANGE_COOLDOWN_MS + 1000);
    expect((await payoutAccountView(prisma, userId, later)).cooldownHoursLeft).toBeNull();
  });

  it('**계좌 없이 미리 잠근 것을 "등록됨"으로 세지 않는다** — 빈 행이 생긴다', async () => {
    const userId = await makeUser('pre@p.io');
    await freezePayouts(prisma, { researcherUserId: userId, actor: userId }, NOW);
    const v = await payoutAccountView(prisma, userId, NOW);
    expect(v.frozen).toBe(true);
    expect(v.registered).toBe(false); // 잠갔다고 계좌가 생긴 것은 아니다
    expect(v.last4).toBeNull();
  });

  it('동결은 멱등이다 — 급한 사람은 버튼을 두 번 누른다', async () => {
    const userId = await makeUser('twice@p.io');
    await freezePayouts(prisma, { researcherUserId: userId, actor: userId }, NOW);
    await expect(
      freezePayouts(prisma, { researcherUserId: userId, actor: userId }, NOW),
    ).resolves.toBeUndefined();
    expect((await payoutAccountView(prisma, userId, NOW)).frozen).toBe(true);
  });
});
