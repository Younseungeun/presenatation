import type { PrismaClient } from '@prisma/client';

// **한 달에 플랫폼 자본에서 나갈 수 있는 보상금의 상한** (2026-08-16, 외부 검토 C-2).
//
// ── 일일 한도와 무엇이 다른가 ───────────────────────────────────
// 둘 다 벽이지만 재는 것이 다르다:
//
//   · 일일 출금 한도(payoutVelocity) — **피해 반경.** 세션 탈취든 버그든 실수든,
//     하루에 밖으로 나갈 수 있는 총액을 묶는다. 원인을 가리지 않는다
//   · 월 보상 예산(여기)          — **손실 규모.** 이건 남의 돈을 나눠 주는 것이
//     아니라 **우리가 지는 손해**라, 상한이 없으면 장애 한 번이 회사를 지운다
//
// 그래서 보상은 두 벽을 **모두** 지난다. 일일 한도만 있으면 하루 한도 안쪽 금액이
// 한 달 내내 나가는 것을 아무것도 막지 못하고, 월 예산만 있으면 예산 전액이 한 시간에
// 나가는 것을 막지 못한다.
//
// ── 왜 상태로 저장하지 않는가 ───────────────────────────────────
// 검토는 예산 초과 건을 `PENDING_BUDGET_APPROVAL` 상태로 두라고 했다. 채택하지 않았다 —
// **달이 바뀌면 예산은 리셋되는데 그 행은 스스로 안 풀린다.** 그러면 "예산은 남았는데
// 상태 때문에 막힌 건"이 생기고, 그걸 푸는 배치를 또 만들어야 하고, 그 배치가 안 돌면
// 리서처 돈이 상태값 하나에 갇힌다. 유예 기산점을 `updatedAt`에서 명시적 `pausedAt`으로
// 옮길 때 배운 것과 같은 교훈이다: **계산으로 나오는 값을 저장하면 저장된 값이 썩는다.**
// 예산 초과는 실행 시점에 계산해 던지고, 큐에는 승인된 채로 남아 다음 달에 그냥 나간다.

/**
 * 월 보상 예산 (원).
 *
 * 초기 규모(카드당 5천~5만원)에서 **장애 한 번이 카드 수백 장을 닫아도 덮이는** 선으로
 * 잡았다. 이 벽에 닿는다는 것은 보상해야 할 사고가 그만큼 났다는 뜻이므로, 그때 필요한
 * 것은 자동 실행이 아니라 **사람이 사고를 들여다보는 일**이다.
 */
export const MONTHLY_COMPENSATION_BUDGET_KRW = 5_000_000;

export class CompensationBudgetExceeded extends Error {
  constructor(
    readonly monthKrw: number,
    readonly requestedKrw: number,
    readonly budgetKrw: number,
  ) {
    super(
      `이번 달 보상 예산을 넘습니다 — 이미 ${monthKrw.toLocaleString()}원, ` +
        `이번 건 ${requestedKrw.toLocaleString()}원, 예산 ${budgetKrw.toLocaleString()}원.\n` +
        `이 벽에 닿았다는 것은 이번 달에 판정을 못 한 건이 그만큼 많았다는 뜻입니다 — ` +
        `개별 건을 밀어 넣기 전에 원인부터 확인하세요. ` +
        `승인 상태는 그대로 남으므로 다음 달에 그대로 실행됩니다.`,
    );
    this.name = 'CompensationBudgetExceeded';
  }
}

/** 그 달 1일 0시 (서버 시간) */
function startOfMonth(now: Date): Date {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** 이번 달에 이미 실행된 보상금의 합 */
export async function monthCompensatedKrw(prisma: PrismaClient, now = new Date()): Promise<number> {
  const agg = await prisma.compensationInstruction.aggregate({
    where: { executedAt: { gte: startOfMonth(now) } },
    _sum: { amountKrw: true },
  });
  return agg._sum.amountKrw ?? 0;
}

/** 이 금액을 지금 보상해도 되는가 — **넘으면 던진다.** */
export async function assertWithinMonthlyBudget(
  prisma: PrismaClient,
  amountKrw: number,
  now = new Date(),
  budgetKrw = MONTHLY_COMPENSATION_BUDGET_KRW,
): Promise<void> {
  if (amountKrw <= 0) return;
  const spent = await monthCompensatedKrw(prisma, now);
  if (spent + amountKrw > budgetKrw) {
    throw new CompensationBudgetExceeded(spent, amountKrw, budgetKrw);
  }
}
