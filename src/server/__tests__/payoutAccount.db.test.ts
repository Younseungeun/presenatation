import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { hashCi } from '../authService';
import { decryptField, encryptField, last4 } from '../fieldCrypto';
import {
  ACCOUNT_CHANGE_COOLDOWN_MS,
  applyHolderLookup,
  assertPayoutAccountReady,
  freezePayouts,
  PayoutAccountError,
  registerPayoutAccount,
  unfreezePayouts,
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

/** 계정 주인의 본인 인증 결과 — 계좌 등록마다 이것을 다시 받는다 */
const OWNER = { ci: 'ci-owner-hong', name: '홍길동' };
/** 탈취자가 자기 명의로 받은 인증 — 이름은 맞지만 **다른 사람**이다 */
const ATTACKER = { ci: 'ci-attacker-kim', name: '김철수' };

beforeAll(async () => {
  prisma = createTestDb('payout-account-');
  const u = await prisma.user.create({
    data: {
      email: 'r@acct.io',
      identityVerified: true,
      identityHash: hashCi(OWNER.ci),
      researcherProfile: { create: {} },
    },
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
      { researcherUserId, bankCode: '004', accountNumber: '110-234-567890', actor: researcherUserId, identity: OWNER },
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
      { researcherUserId, holderName: '홍길동', actor: 'system:bank' },
      NOW,
    );
    expect(status).toBe('VERIFIED');
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).resolves.toBeUndefined();
  });

  // **대조 상대편은 저장된 값이지 호출자가 넘기는 값이 아니다.** 넘기게 두면 언젠가
  // "본인이 적은 이름"이 그 자리에 들어오고, 그러면 양쪽을 다 본인이 적는 것이 된다
  it('이름이 다르면 예금주 불일치다 — 호출자가 무엇을 넘기든', async () => {
    const status = await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '아무개', actor: 'system:bank' },
      NOW,
    );
    expect(status).toBe('HOLDER_MISMATCH');
  });

  // ── ④가 없으면 ③은 뚫린다 ────────────────────────────────
  // 탈취자가 **자기 이름으로** 인증하고 **자기 계좌**를 등록하면 이름이 서로 맞는다.
  // 대조는 성공하는데 돈은 남에게 간다. 그래서 인증이 계정 주인의 것인지를 본다
  it('**다른 사람 명의의 인증으로는 계좌를 바꿀 수 없다**', async () => {
    await expect(
      registerPayoutAccount(
        prisma,
        {
          researcherUserId,
          bankCode: '004',
          accountNumber: '777-666-555444',
          actor: researcherUserId,
          identity: ATTACKER,
        },
        NOW,
      ),
    ).rejects.toThrow(/계정과 일치하지 않습니다/);

    // 계좌가 바뀌지 않았다 — 실패한 등록이 상태를 건드리면 그 자체가 공격 수단이 된다
    const saved = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    expect(saved.accountLast4).toBe('7890');
  });

  // 실명은 **평문으로 아무 데도 없다** — 계좌번호와 같은 취급이다
  it('본인 인증 실명은 암호화되어 계좌에만 붙는다', async () => {
    const saved = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    expect(saved.verifiedNameEnc).not.toContain('홍길동');
    expect(decryptField(saved.verifiedNameEnc!)).toBe('홍길동');

    // 이력에는 복사하지 않는다 — 같은 사람의 실명은 바뀌지 않아 남길 정보가 없고,
    // 남기면 개인정보 사본만 계좌 변경 횟수만큼 늘어난다.
    // (이력이 들고 있는 이름은 **은행이 돌려준 예금주명**이다. 그건 "어떤 계좌로
    //  바뀌었나"의 일부라 남는 것이 맞다 — 대조의 상대편인 본인 인증 실명과 다르다)
    const history = await prisma.payoutAccountHistory.findMany({ where: { researcherUserId } });
    expect(history.length).toBeGreaterThan(0);
    for (const row of history) {
      expect(row).not.toHaveProperty('verifiedNameEnc');
    }
  });

  it('예금주가 다르면 지급을 막는다', async () => {
    const status = await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '김철수', actor: 'system:bank' },
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
      { researcherUserId, holderName: '홍길동', actor: 'system:bank' },
      NOW,
    );
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).resolves.toBeUndefined();

    await registerPayoutAccount(
      prisma,
      { researcherUserId, bankCode: '020', accountNumber: '999-888-777666', actor: researcherUserId, identity: OWNER },
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
      { researcherUserId, holderName: '홍길동', actor: 'system:bank' },
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

// ── 동결: **거는 것은 누구나, 푸는 것은 운영자만** (2026-08-16) ────────────
//
// 쿨다운 48시간의 값어치는 기다림 자체가 아니라 **그 사이에 진짜 주인이 멈출 수
// 있다는 것**이다. 멈출 방법이 없으면 48시간은 그냥 지연이다.
//
// 비대칭이 장치의 전부다: 본인이 풀 수 있으면 계정을 쥔 탈취자가 풀 수 있다.
// 잘못 건 동결의 대가는 "운영자에게 연락"이고, 못 건 동결의 대가는 돈이 나가는 것이다.
describe('정산 동결', () => {
  const OPERATOR = 'op-freeze';

  it('동결하면 검증된 계좌라도 지급이 막힌다', async () => {
    const past = new Date('2026-09-01T00:00:00Z');
    await registerPayoutAccount(
      prisma,
      { researcherUserId, bankCode: '004', accountNumber: '110-111-222333', actor: researcherUserId, identity: OWNER },
      new Date(past.getTime() - ACCOUNT_CHANGE_COOLDOWN_MS - 3_600_000),
    );
    await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '홍길동', actor: 'system:bank' },
      past,
    );
    await expect(assertPayoutAccountReady(prisma, researcherUserId, past)).resolves.toBeUndefined();

    await freezePayouts(prisma, { researcherUserId, actor: researcherUserId, reason: '내가 안 바꿨다' }, past);
    await expect(assertPayoutAccountReady(prisma, researcherUserId, past)).rejects.toThrow(
      /동결된 계정입니다/,
    );
  });

  // **동결이 가장 먼저 걸린다** — "본인이 아닐 수 있다"는 신고라, 다른 조건이 통과하든
  // 무관하게 막아야 한다. 뒤에 두면 "검증됐으니 나간다"가 먼저 읽힌다
  it('동결 사유가 다른 어떤 사유보다 먼저 보고된다', async () => {
    const past = new Date('2026-09-02T00:00:00Z');
    await registerPayoutAccount(
      prisma,
      { researcherUserId, bankCode: '004', accountNumber: '110-999-000111', actor: researcherUserId, identity: OWNER },
      past,
    );
    // 지금은 미검증 + 쿨다운 + 동결이 전부 걸린 상태
    await expect(assertPayoutAccountReady(prisma, researcherUserId, past)).rejects.toThrow(
      /동결된 계정입니다/,
    );
  });

  it('사유 없이는 동결을 풀 수 없다', async () => {
    await expect(
      unfreezePayouts(prisma, { researcherUserId, operatorUserId: OPERATOR, reason: '  ' }),
    ).rejects.toThrow(PayoutAccountError);
  });

  it('운영자가 풀면 감사 로그가 남고, 계좌 검증 상태는 건드리지 않는다', async () => {
    const before = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    await unfreezePayouts(prisma, {
      researcherUserId,
      operatorUserId: OPERATOR,
      reason: '본인 통화 확인 — 본인이 변경한 것이 맞음',
    });
    const after = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    expect(after.frozenAt).toBeNull();
    // 동결 해제는 "지급을 다시 연다"이지 "이 계좌가 본인 것이다"가 아니다
    expect(after.status).toBe(before.status);

    expect(
      await prisma.auditLog.count({
        where: { action: 'PAYOUT_FREEZE_SET', targetId: researcherUserId },
      }),
    ).toBe(1);
  });

  it('동결되지 않은 계좌는 풀 수 없다', async () => {
    await expect(
      unfreezePayouts(prisma, { researcherUserId, operatorUserId: OPERATOR, reason: '확인' }),
    ).rejects.toThrow(/동결된 계좌가 아닙니다/);
  });

  // 탈취자가 **계좌를 등록하기 전에** 미리 잠그는 것이 가장 이른 방어다
  it('계좌가 아직 없어도 미리 동결할 수 있다', async () => {
    await freezePayouts(prisma, { researcherUserId: 'newcomer', actor: 'newcomer' });
    await expect(assertPayoutAccountReady(prisma, 'newcomer')).rejects.toThrow(/동결된 계정입니다/);
  });
});
