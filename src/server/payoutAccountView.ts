import type { PrismaClient } from '@prisma/client';

// 본인이 보는 정산 계좌 상태 — **동결 버튼이 놓일 화면의 데이터.**
//
// 서비스 함수(freezePayouts)는 41차에 만들었는데 **누를 곳이 없었다.** 42차 검토가
// "보안은 기능이 아니라 UX에서 완성된다"고 짚은 그대로다 — 리서처가 알림을 보고
// 잠글 수 있어야 48시간 쿨다운이 골든타임이 되고, 못 잠그면 그냥 지연이다.
//
// **계좌번호는 절대 나가지 않는다.** 뒤 4자리만 보낸다 — 화면이 필요로 하는 것은
// "내가 아는 그 계좌가 맞나"이지 계좌번호 자체가 아니고, 계정을 쥔 사람에게 전체
// 번호를 보여 주면 탈취가 그대로 계좌 정보 유출이 된다.

export type PayoutAccountView = {
  registered: boolean;
  /** 뒤 4자리만 — 전체 번호는 어떤 경로로도 나가지 않는다 */
  last4: string | null;
  bankCode: string | null;
  status: string | null;
  frozen: boolean;
  frozenAt: string | null;
  /** 변경 쿨다운이 남아 있으면 남은 시간(시간 단위), 없으면 null */
  cooldownHoursLeft: number | null;
  changedAt: string | null;
  /**
   * 유예 즉시 해제 확인 번호 — **낯선 기기에서 볼 때만** 실린다.
   * 번호는 새 기기 화면에 뜨고 입력은 평소 기기에서만 받는 구조라, 어느 화면에
   * 무엇을 보여줄지가 곧 보안이다: 평소 기기에 번호까지 보여주면 "두 기기를 오가며
   * 확인한다"는 절차가 한 화면의 셀프 승인으로 무너진다.
   */
  cooldownCode: string | null;
  /** 이 기기(평소 기기)에서 확인 번호를 입력해 유예를 끝낼 수 있는가 */
  canConfirmCooldown: boolean;
};

export async function payoutAccountView(
  prisma: PrismaClient,
  researcherUserId: string,
  /** 이 요청이 평소 로그인 기기에서 왔는가 — 화면이 번호를 보여줄지 입력을 받을지 가른다 */
  trustedDevice = false,
  now = new Date(),
): Promise<PayoutAccountView> {
  const a = await prisma.payoutAccount.findUnique({ where: { researcherUserId } });
  if (!a) {
    return {
      registered: false,
      last4: null,
      bankCode: null,
      status: null,
      frozen: false,
      frozenAt: null,
      cooldownHoursLeft: null,
      changedAt: null,
      cooldownCode: null,
      canConfirmCooldown: false,
    };
  }
  // 쿨다운은 낯선 기기에서 바꾼 경우에만 걸려 있다 — 평소 기기 변경은 이 칸이 null
  const left = a.cooldownUntil ? a.cooldownUntil.getTime() - now.getTime() : 0;
  const cooldownActive = left > 0;
  return {
    // 계좌 없이 미리 잠근 경우 빈 행이 생긴다(freezePayouts) — 그건 "등록됨"이 아니다
    registered: a.accountNumberEnc !== '',
    last4: a.accountNumberEnc === '' ? null : a.accountLast4,
    bankCode: a.bankCode || null,
    status: a.accountNumberEnc === '' ? null : a.status,
    frozen: a.frozenAt != null,
    frozenAt: a.frozenAt?.toISOString() ?? null,
    cooldownHoursLeft: cooldownActive ? Math.ceil(left / 3_600_000) : null,
    changedAt: a.changedAt.toISOString(),
    cooldownCode: cooldownActive && !trustedDevice ? a.cooldownCode : null,
    canConfirmCooldown: cooldownActive && trustedDevice && a.cooldownCode != null,
  };
}
