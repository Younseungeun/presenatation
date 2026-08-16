import type { PrismaClient } from '@prisma/client';
import { encryptField, last4 } from './fieldCrypto';
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
//   ③ 예금주명 ↔ 본인 인증 실명 대조                                    ← **없음**
// ③이 없는 동안 `VERIFIED`는 **"계좌가 실재한다"까지만** 뜻한다. 그 사실을 이름으로
// 감추지 않으려고 아래 상수와 오류 문구가 그대로 말한다.

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
 * 계좌를 등록하거나 바꾼다 — **언제나 미검증으로 떨어진다.**
 *
 * 같은 값을 다시 저장해도 미검증이 되는데, 그게 맞다: "같은 계좌인지"를 판단하려면
 * 저장된 원문을 복호화해 비교해야 하고, 그 비교를 위해 원문을 꺼내는 것이 이 설계가
 * 피하려는 바로 그 일이다. 사람이 실수로 같은 값을 다시 넣으면 재인증 한 번이 비용이다.
 */
export async function registerPayoutAccount(
  prisma: PrismaClient,
  input: {
    researcherUserId: string;
    bankCode: string;
    accountNumber: string;
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

  const accountNumberEnc = encryptField(digits);
  const accountLast4 = last4(digits);
  const data = {
    bankCode: input.bankCode.trim(),
    accountNumberEnc,
    accountLast4,
    // **예금주명은 지우고 시작한다** — 은행 조회로만 채워지는 칸이라
    // 옛 계좌의 이름이 새 계좌에 남으면 그것이 곧 잘못된 대조다
    holderName: null,
    status: 'UNVERIFIED',
    verifiedAt: null,
    changedAt: now,
  };

  await prisma.payoutAccount.upsert({
    where: { researcherUserId: input.researcherUserId },
    create: { researcherUserId: input.researcherUserId, ...data, createdAt: now },
    update: data,
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
 * ⚠ **실명 대조는 아직 없다.** 본인 인증 실명을 저장하지 않기 때문이다(개인정보처리방침
 * 확정 전). 그래서 지금 이 함수가 낼 수 있는 결론은 "계좌가 실재하고 예금주명을
 * 받았다"까지다. `expectedHolderName`을 넘기면 그때 대조가 켜진다 — 실명 보유가
 * 확정되면 호출자가 그 값을 넘기기 시작하면 되고, 여기는 안 고쳐도 된다.
 */
export async function applyHolderLookup(
  prisma: PrismaClient,
  input: {
    researcherUserId: string;
    /** 은행이 돌려준 예금주명 */
    holderName: string;
    /** 본인 인증 실명 — 없으면 대조하지 않는다 (실명 보유 확정 전) */
    expectedHolderName?: string | null;
    actor: string;
  },
  now = new Date(),
): Promise<AccountStatus> {
  const account = await prisma.payoutAccount.findUnique({
    where: { researcherUserId: input.researcherUserId },
  });
  if (!account) throw new PayoutAccountError('등록된 계좌가 없습니다');

  const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const matched =
    input.expectedHolderName == null ||
    normalize(input.holderName) === normalize(input.expectedHolderName);
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
