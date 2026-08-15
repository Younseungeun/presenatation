import type { PrismaClient } from '@prisma/client';

// **하루에 밖으로 나갈 수 있는 돈의 상한** (2026-08-15).
//
// ── 왜 TOTP보다 이것이 먼저인가 ──────────────────────────────
// 외부 검토가 운영자 보호로 TOTP(2차 인증)와 일일 한도를 함께 제안했다. 둘 다
// 필요하지만 **한도가 먼저**인 이유는 막는 범위가 다르기 때문이다:
//
//   · TOTP는 **세션 탈취**를 막는다 — 공격 경로 하나
//   · 한도는 **돈이 나가는 속도**를 막는다 — 세션 탈취든, 우리 코드 버그든,
//     운영자의 실수든, 배치의 오작동이든 **원인과 무관하게** 같은 벽에 부딪힌다
//
// 검토가 지적한 인포스틸러(브라우저 프로필 통째 복제)는 httpOnly 쿠키를 우회하므로
// TOTP도 필요하다는 지적은 맞다. 다만 그것도 결국 "운영자로 로그인된 상태"이고,
// 그 상태에서 나갈 수 있는 총액을 묶어 두는 것이 **피해의 크기**를 정한다.
//
// ── 왜 도메인 표에서 세는가 ──────────────────────────────────
// 감사 로그(auditLog)가 아니라 Settlement의 실행 시각에서 센다. 감사 로그는 **증명**을
// 위한 표이고 이건 **판단**이다 — 로직이 감사 로그에 의존하면 로그를 지우거나 못 쓰게
// 만드는 것이 곧 한도 우회가 된다. 둘의 역할을 섞지 않는다.

/**
 * 하루 총 지급·환불 상한 (원).
 *
 * 초기 거래 규모(카드당 5천~5만원 × 하루 수십 건)의 **몇 배 위**로 잡았다 —
 * 정상 운영을 막으면 운영자가 한도를 끄는 법을 먼저 배우게 되고, 그러면 없는 것과 같다.
 * 거래가 늘면 함께 올린다(그때 올리는 것은 사람의 판단이고, 그 판단 자체가 기록된다).
 */
export const DAILY_OUTFLOW_LIMIT_KRW = 10_000_000;

export class VelocityLimitExceeded extends Error {
  constructor(
    readonly todayKrw: number,
    readonly requestedKrw: number,
    readonly limitKrw: number,
  ) {
    super(
      `오늘 나간 금액이 한도에 닿았습니다 — 이미 ${todayKrw.toLocaleString()}원, ` +
        `이번 건 ${requestedKrw.toLocaleString()}원, 한도 ${limitKrw.toLocaleString()}원.\n` +
        `정상 운영이라면 한도를 올려야 하고, 아니라면 지금 무슨 일이 일어나는 중입니다 — ` +
        `먼저 감사 로그(AuditLog)에서 오늘 실행 내역을 확인하세요.`,
    );
    this.name = 'VelocityLimitExceeded';
  }
}

/** 그날 0시(서버 시간) — 한도는 달력 하루 단위다 */
function startOfDay(now: Date): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 오늘 이미 실행된 지급 + 환불의 합 */
export async function todayOutflowKrw(prisma: PrismaClient, now = new Date()): Promise<number> {
  const from = startOfDay(now);
  const [payouts, refunds] = await Promise.all([
    prisma.settlement.aggregate({
      where: { payoutExecutedAt: { gte: from } },
      _sum: { researcherPayoutKrw: true },
    }),
    prisma.settlement.aggregate({
      where: { refundExecutedAt: { gte: from } },
      _sum: { buyerRefundKrw: true },
    }),
  ]);
  return (payouts._sum.researcherPayoutKrw ?? 0) + (refunds._sum.buyerRefundKrw ?? 0);
}

/**
 * 이 금액을 지금 내보내도 되는가 — **넘으면 던진다.**
 *
 * 실행 직전에 부른다. 한 건이 통과했다고 다음 건이 통과하는 것이 아니므로
 * (앞 건이 합계를 올린다) 매 건 다시 센다.
 */
export async function assertWithinDailyLimit(
  prisma: PrismaClient,
  amountKrw: number,
  now = new Date(),
  limitKrw = DAILY_OUTFLOW_LIMIT_KRW,
): Promise<void> {
  if (amountKrw <= 0) return;
  const today = await todayOutflowKrw(prisma, now);
  if (today + amountKrw > limitKrw) {
    throw new VelocityLimitExceeded(today, amountKrw, limitKrw);
  }
}
