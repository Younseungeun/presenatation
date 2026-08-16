import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { decryptField, encryptField, last4 } from '../fieldCrypto';
import {
  ACCOUNT_CHANGE_COOLDOWN_MS,
  applyHolderLookup,
  assertPayoutAccountReady,
  PayoutAccountError,
  registerPayoutAccount,
} from '../payoutAccountService';

// **돈이 어디로 나가는지 시스템이 알게 하는 표.**
//
// 지금까지 지급은 운영자가 시스템 **밖에서** 이체하고 참조번호만 적었다 — 즉
// 시스템은 돈이 누구 계좌로 갔는지 몰랐다. 이 파일이 지키는 것은 셋이다:
//   ① 지시서에 계좌를 **박지 않는다** (실행 시점에 지금 등록된 계좌를 본다)
//   ② 계좌를 바꾸면 **즉시 미검증**으로 떨어지고, 미검증에는 한 푼도 안 나간다
//   ③ 바꾼 직후에는 검증돼도 안 나간다 (탈취자가 바꾸고 곧바로 빼 가는 경로)

let prisma: PrismaClient;
let researcherUserId: string;

const NOW = new Date('2026-08-16T00:00:00Z');
const LATER = new Date(NOW.getTime() + ACCOUNT_CHANGE_COOLDOWN_MS + 3_600_000);

beforeAll(async () => {
  prisma = createTestDb('payout-account-');
  const u = await prisma.user.create({
    data: { email: 'r@acct.io', identityVerified: true, researcherProfile: { create: {} } },
  });
  researcherUserId = u.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('필드 암호화', () => {
  // 계좌번호는 **은행에 그대로 보내야** 하므로 해시로 못 남긴다 — 가역이어야 한다
  it('암호화한 값을 그대로 되돌린다', () => {
    const plain = '110234567890';
    expect(decryptField(encryptField(plain))).toBe(plain);
  });

  // 같은 값도 매번 다른 암호문 — IV가 매번 새로 생긴다. 같으면 "누가 같은 계좌를
  // 쓰는지"가 암호문 비교만으로 드러난다
  it('같은 값이라도 매번 다른 암호문이 된다', () => {
    expect(encryptField('110234567890')).not.toBe(encryptField('110234567890'));
  });

  // GCM 인증 태그 — 조작된 암호문은 **그럴듯한 쓰레기를 돌려주지 않고 던진다.**
  // 돈이 나가는 경로에서 가장 나쁜 실패가 "틀린 값을 조용히 돌려주는 것"이다
  it('조작된 암호문은 복호화되지 않고 던진다', () => {
    const enc = encryptField('110234567890');
    const [iv, tag, data] = enc.split(':');
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decryptField([iv, tag, flipped.toString('base64')].join(':'))).toThrow();
  });

  // 뒤 4자리가 있어야 "어느 계좌인가"를 묻는 데 **복호화가 필요 없어진다**
  it('뒤 4자리는 원문 없이 보여줄 수 있다', () => {
    expect(last4('110-234-567890')).toBe('7890');
    expect(last4('12')).toBe('**12');
  });
});

describe('계좌 등록·검증', () => {
  it('등록하면 언제나 미검증으로 시작한다', async () => {
    const r = await registerPayoutAccount(
      prisma,
      { researcherUserId, bankCode: '004', accountNumber: '110-234-567890', actor: researcherUserId },
      NOW,
    );
    expect(r.status).toBe('UNVERIFIED');
    expect(r.accountLast4).toBe('7890');

    const saved = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    // **원문은 어디에도 평문으로 없다**
    expect(saved.accountNumberEnc).not.toContain('110234567890');
    expect(decryptField(saved.accountNumberEnc)).toBe('110234567890');
    expect(saved.holderName).toBeNull(); // 은행 조회로만 채워진다
  });

  it('미검증 계좌에는 지급하지 않는다', async () => {
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).rejects.toThrow(
      PayoutAccountError,
    );
  });

  it('계좌가 아예 없으면 지급하지 않는다', async () => {
    await expect(assertPayoutAccountReady(prisma, 'nobody', LATER)).rejects.toThrow(
      /등록되지 않았습니다/,
    );
  });

  // 예금주명을 **본인에게 입력받지 않는다** — 양쪽을 다 본인이 적으면 대조가 아니다
  it('은행 조회 결과로 검증된다', async () => {
    const status = await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '홍길동', actor: 'system:bank', expectedHolderName: '홍길동' },
      NOW,
    );
    expect(status).toBe('VERIFIED');
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).resolves.toBeUndefined();
  });

  // 실명 대조가 **아직 없는 상태**를 그대로 시험한다 — expectedHolderName을 안 넘기면
  // 대조하지 않는다. 그동안 VERIFIED는 "계좌가 실재한다"까지만 뜻한다
  it('본인 실명을 모르면 대조하지 않고 통과시킨다 (실명 보유 확정 전)', async () => {
    const status = await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '아무개', actor: 'system:bank' },
      NOW,
    );
    expect(status).toBe('VERIFIED');
  });

  it('예금주가 다르면 지급을 막는다', async () => {
    const status = await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '김철수', actor: 'system:bank', expectedHolderName: '홍길동' },
      NOW,
    );
    expect(status).toBe('HOLDER_MISMATCH');
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).rejects.toThrow(
      /예금주가 본인과 일치하지 않습니다/,
    );
  });
});

describe('변경 방어', () => {
  // **지시서에 계좌를 박지 않는 대신** 이것이 탈취를 막는다.
  // 실시간 조회 자체는 아무것도 안 막는다 — 탈취자가 바꾸면 그 계좌로 나갈 뿐이다
  it('계좌를 바꾸면 검증이 즉시 풀린다', async () => {
    await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '홍길동', actor: 'system:bank', expectedHolderName: '홍길동' },
      NOW,
    );
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).resolves.toBeUndefined();

    await registerPayoutAccount(
      prisma,
      { researcherUserId, bankCode: '020', accountNumber: '999-888-777666', actor: researcherUserId },
      LATER,
    );
    const after = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    expect(after.status).toBe('UNVERIFIED');
    expect(after.holderName).toBeNull(); // 옛 계좌의 이름이 새 계좌에 남으면 그게 잘못된 대조다
  });

  // 검증까지 마쳐도 **바꾼 직후에는** 안 나간다 — 그 사이 본인 알림이 가서
  // "내가 안 바꿨다"고 말할 창이 생긴다
  it('바꾼 직후에는 검증돼도 지급하지 않는다', async () => {
    await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '홍길동', actor: 'system:bank', expectedHolderName: '홍길동' },
      LATER,
    );
    // 변경 직후
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).rejects.toThrow(
      /계좌를 바꾼 지 얼마 되지 않았습니다/,
    );
    // 쿨다운이 지나면 통과
    const past = new Date(LATER.getTime() + ACCOUNT_CHANGE_COOLDOWN_MS + 1000);
    await expect(assertPayoutAccountReady(prisma, researcherUserId, past)).resolves.toBeUndefined();
  });

  // 덮어쓰는 표만 있으면 "언제 어떤 계좌로 바뀌었나"에 답할 수 없다.
  // 그 질문은 정산 분쟁·수사 협조에서 반드시 나온다
  it('변경 이력이 덧붙기만 하며 남는다', async () => {
    const history = await prisma.payoutAccountHistory.findMany({
      where: { researcherUserId },
      orderBy: { recordedAt: 'asc' },
    });
    expect(history.length).toBeGreaterThanOrEqual(4); // 등록 2회 + 조회 결과들
    expect(history.map((h) => h.accountLast4)).toContain('7890');
    expect(history.map((h) => h.accountLast4)).toContain('7666');
    expect(history.some((h) => h.status === 'HOLDER_MISMATCH')).toBe(true);
  });
});
