import type { PrismaClient } from '@prisma/client';
import { auditOp } from './auditLog';
import { hashCi } from './authService';
import { decryptField, encryptField, last4 } from './fieldCrypto';
import { notifyOperators } from './opsAlert';

// 정산받을 계좌의 등록·검증·관문.
//
// ── 관문은 **실행 시점 한 곳**이다 ──────────────────────────────
// 지급(Settlement)·보상(CompensationInstruction) 어느 쪽도 **상태를 늘리지 않는다.**
// 실행 직전에 "지금 이 사람의 계좌가 검증됐는가"만 묻는다. 지시서에 계좌를 박아 두면
// 바꾼 뒤에도 옛 계좌로 나가고, 그건 이체 실패(해지된 계좌)이거나 탈취 피해(되돌려
// 놓았는데도 옛 스냅샷이 나감) 둘 중 하나가 된다.
//
// ── 무엇이 탈취를 막나 ─────────────────────────────────────────
// **실시간 조회 자체는 아무것도 막지 못한다.** 탈취자가 자기 계좌로 바꾸면 그 계좌로
// 나갈 뿐이다. 막는 것은 아래 세 겹이고, 지금 있는 것은 앞의 둘뿐이다:
//   ① 바꾸면 즉시 미검증 — 미검증에는 한 푼도 안 나간다                    ← 있음
//   ② 변경 쿨다운 — 그 사이 본인 알림이 가서 "내가 안 바꿨다"고 말할 창이 생긴다  ← 있음
//   ③ 예금주명 ↔ 본인 인증 실명 대조                                    ← 있음(2026-08-16)
//   ④ **계좌 등록 시 본인 인증 재확인** — 계정만 뚫어서는 계좌를 못 바꾼다   ← 있음(2026-08-16)
//
// ── ④가 ③을 실제로 작동하게 만든다 ─────────────────────────────
// ③만 있으면 뚫린다: 탈취자가 **자기 이름으로** 본인 인증을 하고 **자기 계좌**를
// 등록하면 이름이 서로 맞아 통과한다. 대조는 성공하는데 돈은 남에게 간다.
//
// 그래서 재인증의 CI 해시가 **계정 주인의 것과 같은지**를 본다. 다르면 거절이다 —
// 탈취자는 진짜 주인의 명의로 본인 인증을 통과해야 하고, 그건 계정 탈취와 다른 문제다.
// **대조하는 이름이 "누구의 이름인지"를 묶어 두는 것이 이 방어의 핵심이다.**

export class PayoutAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayoutAccountError';
  }
}

export const ACCOUNT_STATUSES = ['UNVERIFIED', 'VERIFIED', 'HOLDER_MISMATCH'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * 계좌를 바꾼 뒤 이만큼은 검증됐어도 돈을 안 내보낸다.
 *
 * 탈취자가 계좌를 바꾸고 곧바로 빼 가는 경로를 막는 유일한 장치다(실명 대조가 붙기
 * 전까지는). 길이의 근거는 **사람이 알림을 보고 반응하는 시간**이라 쿨다운(48시간)과
 * 같은 계산이다 — 알림을 못 본 하루를 흡수하고도 하루가 남아야 한다.
 *
 * @근거 설계 사람이 알림을 보고 반응하는 시간 — 정산 쿨다운(48h)과 같은 계산
 */
export const ACCOUNT_CHANGE_COOLDOWN_MS = 48 * 3_600_000;

/**
 * 계좌를 등록하거나 바꾼다 — **언제나 미검증으로 떨어지고, 언제나 재인증을 요구한다.**
 *
 * 같은 값을 다시 저장해도 미검증이 되는데, 그게 맞다: "같은 계좌인지"를 판단하려면
 * 저장된 원문을 복호화해 비교해야 하고, 그 비교를 위해 원문을 꺼내는 것이 이 설계가
 * 피하려는 바로 그 일이다. 사람이 실수로 같은 값을 다시 넣으면 재인증 한 번이 비용이다.
 *
 * **재인증을 받는 형태가 곧 강제다.** 인증 결과를 인자로 요구하므로, 이 함수를 부르는
 * 어떤 경로도 본인 인증 없이 계좌를 바꿀 수 없다 — "부르기 전에 확인하세요"라는
 * 주석이었다면 언젠가 그냥 지나쳤을 것이다.
 */
export async function registerPayoutAccount(
  prisma: PrismaClient,
  input: {
    researcherUserId: string;
    bankCode: string;
    accountNumber: string;
    /**
     * **방금 받은 본인 인증 결과.** 이름은 예금주 대조의 상대편이 되고,
     * CI는 "이 인증이 계정 주인의 것인가"를 확인하는 데 쓰인다(원문은 저장하지 않는다).
     */
    identity: { ci: string; name: string };
    /** 누가 바꿨나 — 본인이면 userId, 운영자 개입이면 그 운영자 */
    actor: string;
  },
  now = new Date(),
): Promise<{ accountLast4: string; status: AccountStatus }> {
  const digits = input.accountNumber.replace(/\D/g, '');
  if (digits.length < 8) {
    throw new PayoutAccountError('계좌번호가 올바르지 않습니다');
  }
  if (!input.bankCode.trim()) {
    throw new PayoutAccountError('은행을 선택해주세요');
  }
  const verifiedName = input.identity.name.trim();
  if (!verifiedName) {
    throw new PayoutAccountError('본인 인증 응답에 이름이 없습니다');
  }

  // ── 이 인증이 **계정 주인의 것인가** ─────────────────────────
  // 여기가 ④의 전부다. 이 확인이 없으면 탈취자가 자기 이름으로 인증하고 자기 계좌를
  // 등록해 대조를 통과시킬 수 있다 — 대조는 성공하는데 돈은 남에게 간다.
  const user = await prisma.user.findUnique({
    where: { id: input.researcherUserId },
    select: { identityHash: true },
  });
  if (!user) throw new PayoutAccountError('사용자를 찾을 수 없습니다');
  if (!user.identityHash) {
    throw new PayoutAccountError('본인 인증을 먼저 완료해주세요');
  }
  if (user.identityHash !== hashCi(input.identity.ci)) {
    // 문구가 "다른 사람의 인증"이라고 말하지 않는다 — 탈취자에게 어느 관문에 걸렸는지
    // 알려 주는 만큼 다음 시도가 정교해진다
    throw new PayoutAccountError(
      '본인 인증 정보가 계정과 일치하지 않습니다 — 계정 주인 명의로 인증해주세요.',
    );
  }

  const accountNumberEnc = encryptField(digits);
  const accountLast4 = last4(digits);
  const data = {
    bankCode: input.bankCode.trim(),
    accountNumberEnc,
    accountLast4,
    // **예금주명은 지우고 시작한다** — 은행 조회로만 채워지는 칸이라
    // 옛 계좌의 이름이 새 계좌에 남으면 그것이 곧 잘못된 대조다
    holderName: null,
    // 대조의 상대편. 계좌와 함께 갱신되고, 계좌가 사라지면 함께 사라진다
    verifiedNameEnc: encryptField(verifiedName),
    status: 'UNVERIFIED',
    verifiedAt: null,
    changedAt: now,
  };

  await prisma.payoutAccount.upsert({
    where: { researcherUserId: input.researcherUserId },
    create: { researcherUserId: input.researcherUserId, ...data, createdAt: now },
    update: data,
  });

  // ── 쿨다운을 **골든타임**으로 만든다 (2026-08-16, 외부 검토 A) ──────────
  //
  // 48시간의 값어치는 기다림 자체가 아니라 **그 사이에 진짜 주인이 멈출 수 있다는
  // 것**이다. 멈출 방법이 없으면 그냥 지연일 뿐이다. 그래서 문구가 "지급이 늦어진다"가
  // 아니라 **"본인이 바꾼 것이 맞습니까"**를 먼저 묻는다.
  //
  // ⚠ **이 장치의 한계를 정직하게 적어 둔다**: 알림이 의미를 가지려면 **탈취자가
  // 통제하지 못하는 경로**로 가야 하는데, 지금 있는 것은 인앱 알림뿐이다. 계정을 쥔
  // 사람은 이 알림도 본다(다만 동결을 풀지는 못한다 — 그건 운영자만 한다).
  // 본인 인증 실공급자가 붙어 문자·이메일이 생기면 그쪽을 함께 써야 완성된다.
  await prisma.notification.create({
    data: {
      userId: input.researcherUserId,
      type: 'PAYOUT_ACCOUNT_CHANGED',
      title: '[중요] 정산 계좌가 변경되었습니다',
      body:
        `정산 계좌가 ${data.bankCode} ${accountLast4}로 변경되었습니다. ` +
        `본인이 변경한 것이 맞다면 은행 예금주 확인 후 ${ACCOUNT_CHANGE_COOLDOWN_MS / 3_600_000}시간 뒤부터 새 계좌로 지급됩니다.\n` +
        '**본인이 변경하지 않았다면 지금 바로 정산을 동결해주세요.** ' +
        '동결하면 확인이 끝날 때까지 한 푼도 나가지 않습니다.',
      link: '/settings',
      createdAt: now,
    },
  });
  // **덧붙이기만 하는 이력** — 덮어쓰는 표만 있으면 "언제 어떤 계좌로 바뀌었나"에
  // 답할 수 없고, 그 질문은 정산 분쟁·수사 협조에서 반드시 나온다
  await prisma.payoutAccountHistory.create({
    data: {
      researcherUserId: input.researcherUserId,
      bankCode: data.bankCode,
      accountNumberEnc,
      accountLast4,
      holderName: null,
      status: 'UNVERIFIED',
      actor: input.actor,
      recordedAt: now,
    },
  });

  return { accountLast4, status: 'UNVERIFIED' };
}

/**
 * 은행 예금주 조회 결과를 반영한다 — **우리가 이름을 지어내지 않는다.**
 *
 * `holderName`은 은행이 돌려준 값만 들어온다. 본인에게 입력받아 대조하면 양쪽을 다
 * 본인이 적는 것이라 아무것도 막지 못한다.
 *
 * 대조 상대편은 **계좌에 붙어 있는 본인 인증 실명**이다(`verifiedNameEnc`). 호출자가
 * 넘기는 값이 아니라 저장된 값을 쓰는 이유는, 넘기게 두면 언젠가 "본인이 적은 이름"이
 * 그 자리에 들어오기 때문이다 — 그러면 양쪽을 다 본인이 적는 것이라 아무것도 못 막는다.
 *
 * 실명이 없는 계좌(재인증이 붙기 전에 등록된 것)는 **대조하지 않고 미검증으로 남긴다.**
 * 통과시키면 옛 계좌들만 조용히 무방비가 된다.
 */
export async function applyHolderLookup(
  prisma: PrismaClient,
  input: {
    researcherUserId: string;
    /** 은행이 돌려준 예금주명 */
    holderName: string;
    actor: string;
  },
  now = new Date(),
): Promise<AccountStatus> {
  const account = await prisma.payoutAccount.findUnique({
    where: { researcherUserId: input.researcherUserId },
  });
  if (!account) throw new PayoutAccountError('등록된 계좌가 없습니다');
  if (!account.verifiedNameEnc) {
    throw new PayoutAccountError(
      '이 계좌에는 본인 인증 실명이 없습니다 — 계좌를 다시 등록해야 대조할 수 있습니다.',
    );
  }

  // 공백·대소문자만 정규화한다. 그 이상 손대면(자모 분해, 유사 문자 치환) **다른 이름을
  // 같다고 말하기 시작**하고, 이 대조에서 거짓 일치는 곧 남의 계좌로 돈이 나가는 것이다
  const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const matched = normalize(input.holderName) === normalize(decryptField(account.verifiedNameEnc));
  const status: AccountStatus = matched ? 'VERIFIED' : 'HOLDER_MISMATCH';

  await prisma.payoutAccount.update({
    where: { researcherUserId: input.researcherUserId },
    data: {
      holderName: input.holderName,
      status,
      verifiedAt: status === 'VERIFIED' ? now : null,
    },
  });
  await prisma.payoutAccountHistory.create({
    data: {
      researcherUserId: input.researcherUserId,
      bankCode: account.bankCode,
      accountNumberEnc: account.accountNumberEnc,
      accountLast4: account.accountLast4,
      holderName: input.holderName,
      status,
      actor: input.actor,
      recordedAt: now,
    },
  });

  if (status === 'HOLDER_MISMATCH') {
    // 명의 불일치는 **사고일 수도 있고 오탈자일 수도 있다.** 자동으로 결론짓지 않고
    // 사람이 본다 — 다만 그동안 돈은 안 나간다(관문이 막는다)
    await notifyOperators(prisma, {
      title: `[확인 필요] 정산 계좌 예금주 불일치 — ${input.researcherUserId}`,
      body: [
        `은행 조회 예금주: ${input.holderName}`,
        '본인 인증 실명과 다릅니다. 지급·보상은 이 계좌로 나가지 않습니다.',
        '오탈자일 수도, 타인 명의일 수도 있습니다 — 어느 쪽인지 확인해주세요.',
      ].join('\n'),
      link: '/admin/settlements',
    });
  }
  return status;
}

/**
 * **정산을 동결한다 — 거는 것은 누구나.**
 *
 * "내가 안 바꿨다"고 말하는 순간이다. 되돌릴 수 없는 쪽(돈이 나가는 것)을 막는
 * 행동이라 문턱을 두지 않는다 — 잘못 걸어도 대가는 "운영자에게 연락해야 한다"이고,
 * 못 걸었을 때의 대가는 돈이 나가는 것이다.
 *
 * 계좌가 아직 없어도 걸 수 있어야 한다: 탈취자가 계좌를 **등록하기 전에** 미리 잠그는
 * 것이 가장 이른 방어다. 그래서 행이 없으면 빈 계좌를 동결 상태로 만들어 둔다.
 */
export async function freezePayouts(
  prisma: PrismaClient,
  input: { researcherUserId: string; actor: string; reason?: string },
  now = new Date(),
): Promise<void> {
  const frozen = { frozenAt: now, frozenBy: input.actor };
  await prisma.payoutAccount.upsert({
    where: { researcherUserId: input.researcherUserId },
    create: {
      researcherUserId: input.researcherUserId,
      bankCode: '',
      accountNumberEnc: '',
      accountLast4: '****',
      status: 'UNVERIFIED',
      changedAt: now,
      createdAt: now,
      ...frozen,
    },
    update: frozen,
  });
  await notifyOperators(prisma, {
    title: `[긴급] 정산 동결 요청 — ${input.researcherUserId}`,
    body: [
      '본인이 정산을 동결했습니다 — "내 계좌가 아니다"라는 신고일 수 있습니다.',
      input.reason ? `사유: ${input.reason}` : '사유 미기재',
      '**해제는 운영자만 할 수 있습니다.** 본인 확인 전에는 풀지 마세요 —',
      '계정을 쥔 사람이 요청하는 것과 진짜 본인의 요청은 화면에서 구별되지 않습니다.',
    ].join('\n'),
    link: '/admin/settlements',
  });
}

/**
 * **동결을 푼다 — 운영자만.**
 *
 * 이 비대칭이 장치의 전부다. 본인이 풀 수 있으면 계정을 쥔 탈취자가 풀 수 있고,
 * 그러면 동결은 아무것도 아니게 된다. 그래서 여기는 `operatorUserId`를 요구하고,
 * 푼 사실을 **감사 로그에 남긴다** — 돈이 다시 나갈 수 있게 만드는 개입이다.
 *
 * ⚠ **계좌 검증 상태는 건드리지 않는다.** 동결 해제는 "이 사람의 지급을 다시 연다"이지
 * "이 계좌가 본인 것이다"가 아니다. 둘을 한 번에 처리하면 운영자가 확인한 것보다
 * 많은 것을 인정하게 된다.
 */
export async function unfreezePayouts(
  prisma: PrismaClient,
  input: { researcherUserId: string; operatorUserId: string; reason: string },
  now = new Date(),
): Promise<void> {
  if (!input.reason.trim()) {
    throw new PayoutAccountError('동결을 풀려면 무엇을 확인했는지 적어주세요');
  }
  const { count } = await prisma.payoutAccount.updateMany({
    where: { researcherUserId: input.researcherUserId, frozenAt: { not: null } },
    data: { frozenAt: null, frozenBy: null },
  });
  if (count === 0) throw new PayoutAccountError('동결된 계좌가 아닙니다');

  await prisma.$transaction([
    auditOp(prisma, {
      actor: input.operatorUserId,
      actorType: 'OPERATOR',
      action: 'PAYOUT_FREEZE_SET',
      targetType: 'PayoutAccount',
      targetId: input.researcherUserId,
      before: { frozen: true },
      after: { frozen: false },
      reason: input.reason.trim(),
      at: now,
    }),
    prisma.notification.create({
      data: {
        userId: input.researcherUserId,
        type: 'PAYOUT_ACCOUNT_CHANGED',
        title: '정산 동결이 해제되었습니다',
        body: '운영자 확인을 거쳐 정산 동결이 해제되었습니다. 계좌 검증이 끝나면 지급이 재개됩니다.',
        link: '/settings',
        createdAt: now,
      },
    }),
  ]);
}

/**
 * **돈이 나가기 직전의 관문.** 통과하지 못하면 던진다.
 *
 * 지급·보상 양쪽이 같은 함수를 부른다 — 돈이 나가는 경로가 늘 때마다 여기에 붙이면
 * 되고, 안 붙이면 그 경로만 조용히 무방비가 된다(일일 한도와 같은 성질이다).
 */
export async function assertPayoutAccountReady(
  prisma: PrismaClient,
  researcherUserId: string,
  now = new Date(),
): Promise<void> {
  const account = await prisma.payoutAccount.findUnique({ where: { researcherUserId } });
  if (!account) {
    throw new PayoutAccountError(
      '정산받을 계좌가 등록되지 않았습니다 — 리서처에게 계좌 등록을 요청해주세요.',
    );
  }
  // **동결이 가장 먼저다.** 이것은 "본인이 아닐 수 있다"는 신고라, 다른 어떤 조건이
  // 통과하든 무관하게 막아야 한다. 뒤에 두면 "검증됐으니 나간다"가 먼저 읽힌다
  if (account.frozenAt) {
    throw new PayoutAccountError(
      '정산이 동결된 계정입니다 — 본인이 계좌 변경을 신고했습니다. ' +
        '운영자가 본인 확인을 마쳐야 해제됩니다(본인은 해제할 수 없습니다).',
    );
  }
  if (account.status !== 'VERIFIED') {
    throw new PayoutAccountError(
      account.status === 'HOLDER_MISMATCH'
        ? `계좌 예금주가 본인과 일치하지 않습니다 (${account.accountLast4}) — 확인 전에는 지급할 수 없습니다.`
        : `계좌가 아직 검증되지 않았습니다 (${account.accountLast4}) — 은행 예금주 조회가 끝나야 지급할 수 있습니다.`,
    );
  }
  const since = now.getTime() - account.changedAt.getTime();
  if (since < ACCOUNT_CHANGE_COOLDOWN_MS) {
    const hours = Math.ceil((ACCOUNT_CHANGE_COOLDOWN_MS - since) / 3_600_000);
    throw new PayoutAccountError(
      `계좌를 바꾼 지 얼마 되지 않았습니다 — ${hours}시간 뒤에 지급할 수 있습니다. ` +
        '탈취된 계정이 계좌를 바꿔 곧바로 빼 가는 경로를 막는 장치입니다(본인에게 변경 알림이 갔습니다).',
    );
  }
}
