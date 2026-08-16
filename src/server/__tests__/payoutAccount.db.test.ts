import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { hashCi } from '../authService';
import { decideApproval, requestApproval } from '../operatorApprovalService';
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
//   ③ **낯선 기기에서** 바꾼 직후에는 검증돼도 안 나간다 (탈취자가 바꾸고 곧바로
//      빼 가는 경로 — 평소 기기는 대기 0, 2026-08-16 사용자 확정 완화)

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
      { researcherUserId, bankCode: '004', accountNumber: '110-234-567890', actor: researcherUserId, identity: OWNER, trustedDevice: false },
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

  // **첫 등록과 변경은 알림이 다르다** — 동결 버튼을 눌러야 하는 쪽은 "내가 안 바꿨는데
  // 바뀌었다"는 사람이다. 첫 등록에도 "변경되었습니다"를 보내면 정상 등록한 사람이
  // 놀라고, 늑대 소년이 되어 진짜 변경 알림의 무게가 깎인다
  it('첫 등록은 "등록", 두 번째부터 "변경"으로 알린다', async () => {
    const first = await prisma.notification.findFirstOrThrow({
      where: { userId: researcherUserId, type: 'PAYOUT_ACCOUNT_CHANGED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(first.title).toContain('등록되었습니다');
    expect(first.title).not.toContain('변경');

    await registerPayoutAccount(
      prisma,
      { researcherUserId, bankCode: '004', accountNumber: '110-234-567890', actor: researcherUserId, identity: OWNER, trustedDevice: false },
      NOW,
    );
    const second = await prisma.notification.findFirstOrThrow({
      where: { userId: researcherUserId, type: 'PAYOUT_ACCOUNT_CHANGED' },
      orderBy: { createdAt: 'desc' },
    });
    // 같은 계좌번호를 다시 넣어도 **변경**이다 — 값을 비교하려면 저장된 원문을
    // 복호화해 꺼내야 하고, 그게 이 설계가 피하려는 바로 그 일이다
    expect(second.title).toContain('변경되었습니다');
  });

  // 동결은 계좌가 없어도 걸 수 있어서 **빈 껍데기 행**이 먼저 생긴다.
  // 그 행을 "이미 계좌가 있다"로 세면 진짜 첫 등록이 "변경"으로 잘못 알려진다
  it('동결로 만들어진 빈 행은 첫 등록 판정을 흐리지 않는다', async () => {
    const other = await prisma.user.create({
      data: { email: 'frozen-first@acct.io', identityVerified: true, identityHash: hashCi('ci-ff') },
    });
    await freezePayouts(prisma, { researcherUserId: other.id, actor: other.id }, NOW);
    await registerPayoutAccount(
      prisma,
      {
        researcherUserId: other.id,
        bankCode: '004',
        accountNumber: '110-999-111222',
        actor: other.id,
        identity: { ci: 'ci-ff', name: '홍길동' },
        trustedDevice: false,
      },
      NOW,
    );
    const noti = await prisma.notification.findFirstOrThrow({
      where: { userId: other.id, type: 'PAYOUT_ACCOUNT_CHANGED' },
    });
    expect(noti.title).toContain('등록되었습니다');
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
          trustedDevice: false,
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
      { researcherUserId, bankCode: '020', accountNumber: '999-888-777666', actor: researcherUserId, identity: OWNER, trustedDevice: false },
      LATER,
    );
    const after = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    expect(after.status).toBe('UNVERIFIED');
    expect(after.holderName).toBeNull(); // 옛 계좌의 이름이 새 계좌에 남으면 그게 잘못된 대조다
  });

  // 검증까지 마쳐도 **낯선 기기에서 바꾼 직후에는** 안 나간다 — 그 사이 본인 알림이
  // 가서 "내가 안 바꿨다"고 말할 창이 생긴다
  it('낯선 기기에서 바꾼 직후에는 검증돼도 지급하지 않는다', async () => {
    await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '홍길동', actor: 'system:bank' },
      LATER,
    );
    // 변경 직후
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).rejects.toThrow(
      /평소 기기가 아닌 곳에서 계좌를 바꾼 직후입니다/,
    );
    // 쿨다운이 지나면 통과
    const past = new Date(LATER.getTime() + ACCOUNT_CHANGE_COOLDOWN_MS + 1000);
    await expect(assertPayoutAccountReady(prisma, researcherUserId, past)).resolves.toBeUndefined();
  });

  // ── 평소 기기 경로 (2026-08-16 사용자 확정 완화) ──────────────
  // 계좌 변경은 본인 인증 재확인 + 예금주명 대조를 이미 지나므로, 남는 위협은
  // "유심 스와핑 + 본인 명의 통장"뿐이고 그 공격자의 기기는 언제나 낯선 기기다.
  // 그래서 평소 로그인 기기에서의 변경은 대기도 고지도 없다 — 방어는 같고
  // 정상 사용자의 대기만 사라진다
  it('평소 기기에서 바꾸면 대기 없이 지급되고, 고지도 없다', async () => {
    const before = await prisma.notification.count({
      where: { userId: researcherUserId, type: 'PAYOUT_ACCOUNT_CHANGED' },
    });
    await registerPayoutAccount(
      prisma,
      { researcherUserId, bankCode: '004', accountNumber: '555-444-333222', actor: researcherUserId, identity: OWNER, trustedDevice: true },
      LATER,
    );
    // 고지가 늘지 않았다 — 본인이 방금 한 일이라 알림은 소음이고,
    // 아끼는 만큼 진짜 경보(낯선 기기)가 무거워진다
    const after = await prisma.notification.count({
      where: { userId: researcherUserId, type: 'PAYOUT_ACCOUNT_CHANGED' },
    });
    expect(after).toBe(before);

    // 검증만 끝나면 **바꾼 그 순간에도** 지급된다 — 쿨다운 칸이 비어 있다
    await applyHolderLookup(
      prisma,
      { researcherUserId, holderName: '홍길동', actor: 'system:bank' },
      LATER,
    );
    await expect(assertPayoutAccountReady(prisma, researcherUserId, LATER)).resolves.toBeUndefined();

    // 이력은 기기와 무관하게 남는다 — 고지를 아낀 것이지 기록을 아낀 것이 아니다
    const history = await prisma.payoutAccountHistory.findMany({
      where: { researcherUserId, accountLast4: '3222' },
    });
    expect(history.length).toBeGreaterThan(0);
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
      { researcherUserId, bankCode: '004', accountNumber: '110-111-222333', actor: researcherUserId, identity: OWNER, trustedDevice: false },
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
      { researcherUserId, bankCode: '004', accountNumber: '110-999-000111', actor: researcherUserId, identity: OWNER, trustedDevice: false },
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

  // **동결 해제에는 다른 운영자의 승인이 필요하다** (2026-08-16 검토 2차 Q3).
  // 동결은 이 시스템에서 방어를 스스로 여는 유일한 행위라, 금액과 무관하게 항상 2인이다
  it('승인 없이는 풀 수 없다 — 운영자 하나가 뚫려도 방어가 안 열린다', async () => {
    await expect(
      unfreezePayouts(prisma, { researcherUserId, operatorUserId: OPERATOR, reason: '확인' }),
    ).rejects.toThrow(/다른 운영자의 승인이 필요합니다/);
  });

  it('운영자가 풀면 감사 로그가 남고, 계좌 검증 상태는 건드리지 않는다', async () => {
    const before = await prisma.payoutAccount.findUniqueOrThrow({ where: { researcherUserId } });
    // 요청과 승인을 다른 사람이 한다 — 요청자는 자기 요청을 승인하지 못한다
    const { id } = await requestApproval(prisma, {
      action: 'PAYOUT_UNFREEZE',
      targetId: researcherUserId,
      summary: '동결 해제',
      requestedBy: OPERATOR,
      reason: '본인 통화 확인',
    });
    await decideApproval(prisma, { approvalId: id, approverUserId: 'op-second', approve: true });

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
    const { id } = await requestApproval(prisma, {
      action: 'PAYOUT_UNFREEZE',
      targetId: researcherUserId,
      summary: '동결 해제',
      requestedBy: OPERATOR,
      reason: '확인',
    });
    await decideApproval(prisma, { approvalId: id, approverUserId: 'op-second', approve: true });
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
