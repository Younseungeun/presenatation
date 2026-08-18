import type { PrismaClient } from '@prisma/client';
import { notifyOperators } from './opsAlert';

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
 *
 * @근거 설계 초기 거래 규모의 몇 배 위 — 정상 운영을 막으면 한도를 끄게 된다
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

/**
 * 오늘 이미 실행된 **지급 + 판정 환불 + 보상 + CS 무효화**의 합.
 *
 * 보상(CompensationInstruction)은 2026-08-16에, **CS 무효화는 2026-08-18에** 들어왔다.
 * 돈이 나가는 경로가 생겼는데 여기 안 세면 **한도가 그만큼 헐거워진다** — 벽의 목적이
 * "오늘 나간 총액"인 이상, 새 경로가 생길 때마다 여기 붙는 것이 이 함수의 계약이다.
 * (두 번 다 그 계약을 놓쳤다가 뒤늦게 붙였다 — 세 번째가 있으면 여기부터 볼 것)
 *
 * CS 무효화는 **정산 행이 없다**(판정 전 구매라 Settlement이 아직 없고, 있으면 오히려
 * 거절된다). 그래서 Settlement만 훑는 위 두 집계에 구조적으로 안 잡히고, 시도 표를
 * 직접 봐야 한다. `SUCCEEDED`만 세는 이유: PENDING은 "나갔는지 우리가 모른다"는 뜻이라
 * 여기 넣으면 한 번도 안 나간 돈이 한도를 갉아먹는다.
 */
export async function todayOutflowKrw(prisma: PrismaClient, now = new Date()): Promise<number> {
  const from = startOfDay(now);
  const [payouts, refunds, compensations, csVoids] = await Promise.all([
    prisma.settlement.aggregate({
      where: { payoutExecutedAt: { gte: from } },
      _sum: { researcherPayoutKrw: true },
    }),
    prisma.settlement.aggregate({
      where: { refundExecutedAt: { gte: from } },
      _sum: { buyerRefundKrw: true },
    }),
    prisma.compensationInstruction.aggregate({
      where: { executedAt: { gte: from } },
      _sum: { amountKrw: true },
    }),
    prisma.refundAttempt.aggregate({
      where: { type: 'CS_CANCEL', status: 'SUCCEEDED', finishedAt: { gte: from } },
      _sum: { amountKrw: true },
    }),
  ]);
  return (
    (payouts._sum.researcherPayoutKrw ?? 0) +
    (refunds._sum.buyerRefundKrw ?? 0) +
    (compensations._sum.amountKrw ?? 0) +
    (csVoids._sum.amountKrw ?? 0)
  );
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

/**
 * 한도에 **닿기 전에** 알린다 (2026-08-16, 외부 검토 C-1).
 *
 * ── 왜 벽에 부딪히는 것만으로는 부족한가 ─────────────────────────
 * 한도는 벽이지 신호가 아니다. 지금까지 운영자가 한도를 아는 유일한 순간은
 * **거부당했을 때**였다 — 그때는 이미 정상 지급이 막힌 뒤고, 급한 사람은 원인을
 * 찾기 전에 "한도를 어떻게 올리나"부터 묻게 된다. 미리 알리면 그 순서가 뒤집힌다.
 *
 * ── 한도 수동 증액 모드는 만들지 않는다 ─────────────────────────
 * 검토는 경보와 함께 "한도 수동 증액 모드"를 제안했다. **경보만 채택한다.**
 * 이 한도가 막으려는 것은 탈취된 세션·오작동 배치인데, 그 세션이 콘솔에서 한도를
 * 올릴 수 있으면 벽에 열쇠를 테이프로 붙여 둔 것이 된다. 그리고 우회 버튼은
 * 두 번째로 눌리는 순간 기본 동작이 된다(쿨다운에 예외를 두지 않은 것과 같은 이유).
 * 한도를 올리는 일은 배포로 남아야 하고, 그 배포 자체가 사람의 판단 기록이다.
 *
 * ── 정상 환불 폭주가 지급을 굶기는 문제(검토의 DoS 우려) ─────────
 * 시장 급락으로 환불이 몰려 리서처 지급이 한도에 밀리는 상황은 실재한다. 다만 그건
 * **손실이 아니라 지연**이다 — 막힌 지시서는 큐에 그대로 남아 다음 날 나가고,
 * 판정 시한 약속(16일)은 판정까지의 약속이라 깨지지 않는다. 그래서 처방은 벽을
 * 올리는 것이 아니라 **순서를 정하는 것**이고, 큐는 이미 `settledAt` 오래된 순이라
 * 가장 오래 기다린 건이 먼저 나간다. 경보는 그 지연이 시작되기 전에 사람을 부른다.
 *
 * @근거 설계 지연이 시작되기 전에 사람을 부르는 자리
 */
export const DAILY_OUTFLOW_ALERT_RATIO = 0.8;

/**
 * 오늘 나간 돈이 한도의 80%를 넘었으면 운영자에게 알린다 (스케줄러가 주기적으로 부른다).
 *
 * 실행 경로에 붙이지 않은 이유: `assertWithinDailyLimit`은 **판단**이고 알림은 곁가지다.
 * 판단 함수에 부작용을 넣으면 "검사만 하고 싶은" 호출자가 알림을 함께 쏘게 된다.
 */
export async function notifyIfOutflowPressure(
  prisma: PrismaClient,
  now = new Date(),
  limitKrw = DAILY_OUTFLOW_LIMIT_KRW,
): Promise<boolean> {
  const today = await todayOutflowKrw(prisma, now);
  if (today < limitKrw * DAILY_OUTFLOW_ALERT_RATIO) return false;
  const pct = Math.round((today / limitKrw) * 100);
  await notifyOperators(prisma, {
    title: `[주의] 오늘 나간 돈이 일일 한도의 ${pct}% — ${today.toLocaleString()}원`,
    body: [
      `한도 ${limitKrw.toLocaleString()}원에 ${(limitKrw - today).toLocaleString()}원 남았습니다.`,
      '남은 지시서는 한도에 닿는 순간부터 **거부**되고 큐에 그대로 남습니다(다음 날 실행됩니다).',
      '지금 확인할 것: 감사 로그(AuditLog)의 오늘 실행 내역이 정상 운영으로 설명되는가.',
      '설명되지 않으면 한도를 올릴 것이 아니라 **무슨 일이 일어나는 중인지**부터 봐야 합니다.',
    ].join('\n'),
    link: '/admin/settlements',
    // 하루 한 번이면 충분하다 — 넘긴 뒤로는 매 회차 조건이 참이라 키가 없으면 도배된다
    dedupeKey: `outflow-pressure:${now.toISOString().slice(0, 10)}`,
    dedupeMs: 24 * 3_600_000,
  });
  return true;
}
