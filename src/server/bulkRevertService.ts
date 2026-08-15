import type { PrismaClient } from '@prisma/client';
import type { AssetClass } from '@/domain/constants';
import { audit } from './auditLog';
import { isJudgmentPaused } from './judgmentPause';
import { JudgmentRevertBlocked, revertJudgment, type RevertCause } from './judgmentRevertService';

// **회차 단위 롤백** — 시세 공급자가 며칠간 틀린 값을 준 것을 뒤늦게 알았을 때 (2026-08-15).
//
// 지금까지는 카드를 한 장씩 되돌리는 것뿐이었다. 100장이면 100번이고, 사고 상황에서
// 그건 없는 것과 같다.
//
// ── 건수 상한을 두지 않는다 ──────────────────────────────────
// 외부 검토는 "20건 하드 상한(서킷 브레이커)"을 제안했다. **정작 이 기능이 필요한
// 순간이 20건을 넘는 순간**이라 받지 않았다 — 100장 사고에서 20건씩 다섯 번을 돌리면
// 그 사이에 **중간 상태**(절반은 되돌려지고 절반은 아닌)가 실재하고, 판정 배치가 한 번
// 끼어들면 되돌린 카드가 같은 오답으로 다시 판정된다.
//
// 대신 오타 한 번으로 전 판정이 날아가는 것은 다른 방법으로 막는다:
//
//   ① **정지가 선행 조건이다.** 자동 판정이 멈춰 있지 않으면 실행 자체를 거부한다.
//      (되돌려 봐야 1.1초 뒤 배치가 같은 데이터로 다시 오판정한다 — judgmentPause)
//   ② **드라이런이 기본이다.** 무엇이 지워지는지 먼저 출력하고, 실행은 별도 플래그다
//   ③ **조회 조건이 좁다.** 판정 시각 구간이 **필수**이고, 자산군·데이터 소스로 더 좁힌다
//
// 상한이 아니라 **절차**로 막는 이유: 상한은 사고의 크기를 모르는 채 고른 숫자이고,
// 절차는 사고의 크기와 무관하게 사람이 눈으로 확인하게 만든다.
//
// ── 자동 재판정하지 않는다 ───────────────────────────────────
// 원인이 시세 소스면 재판정도 같은 소스를 쓴다. `revertJudgment`가 사유에 따라
// `manualJudgmentOnly`를 세우므로 그 성질이 그대로 따라온다 — 여기서 다시 정하지 않는다.

export interface BulkRevertFilter {
  /** 판정 시각 구간 — **필수**. 이것이 없으면 "전부"가 되고, 그게 오타 한 번의 크기다 */
  judgedFrom: Date;
  judgedTo: Date;
  assetClass?: AssetClass;
  /** 판정에 쓰인 데이터 소스 (예: 'fsc-data.go.kr') — 공급자 사고를 정확히 겨눈다 */
  dataSource?: string;
}

export interface BulkRevertPlanItem {
  judgmentId: string;
  cardId: string;
  ticker: string;
  outcome: string;
  judgedAt: Date;
  /** 되돌릴 수 없는 이유 — 없으면 되돌릴 수 있다 */
  blockedBy: string | null;
}

export interface BulkRevertPlan {
  items: BulkRevertPlanItem[];
  revertable: number;
  blocked: number;
  paused: boolean;
}

/**
 * 무엇이 지워질지 **먼저 보여준다.** 아무것도 바꾸지 않는다.
 *
 * "돈이 나간 건"과 "안 나간 건"을 여기서 갈라 둔다 — 나간 건은 장부만 되돌리면
 * **DB는 깨끗한데 현실과 다른** 최악의 상태가 되므로 회계 처리 큐로 넘어가야 한다.
 */
export async function planBulkRevert(
  prisma: PrismaClient,
  filter: BulkRevertFilter,
): Promise<BulkRevertPlan> {
  const judgments = await prisma.judgment.findMany({
    where: {
      judgedAt: { gte: filter.judgedFrom, lte: filter.judgedTo },
      ...(filter.dataSource ? { dataSource: filter.dataSource } : {}),
      ...(filter.assetClass ? { predictionCard: { assetClass: filter.assetClass } } : {}),
    },
    select: {
      id: true,
      outcome: true,
      judgedAt: true,
      predictionCard: {
        select: {
          id: true,
          ticker: true,
          report: {
            select: {
              purchases: {
                select: {
                  settlement: {
                    select: {
                      payoutExecutedAt: true,
                      refundExecutedAt: true,
                      refundAttempts: { select: { status: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    orderBy: { judgedAt: 'asc' },
  });

  const items: BulkRevertPlanItem[] = judgments.map((j) => {
    // `revertJudgment`의 방어선과 **같은 기준**으로 미리 분류한다.
    // 여기서 다른 기준을 쓰면 드라이런이 거짓말을 한다
    let blockedBy: string | null = null;
    for (const p of j.predictionCard.report.purchases) {
      const s = p.settlement;
      if (!s) continue;
      if (s.payoutExecutedAt) blockedBy ??= '리서처 지급이 이미 실행됨';
      else if (s.refundExecutedAt) blockedBy ??= '구매자 환불이 이미 실행됨';
      else if (s.refundAttempts.some((a) => a.status !== 'FAILED'))
        blockedBy ??= '끝나지 않은 환불 시도가 있음';
    }
    return {
      judgmentId: j.id,
      cardId: j.predictionCard.id,
      ticker: j.predictionCard.ticker,
      outcome: j.outcome,
      judgedAt: j.judgedAt,
      blockedBy,
    };
  });

  return {
    items,
    revertable: items.filter((i) => i.blockedBy === null).length,
    blocked: items.filter((i) => i.blockedBy !== null).length,
    paused: await isJudgmentPaused(prisma, filter.assetClass),
  };
}

export class BulkRevertRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkRevertRefused';
  }
}

export interface BulkRevertResult {
  reverted: string[];
  /** 돈이 이미 나가 되돌리지 못한 건 — **회계 처리로 넘어간다** */
  needsAccounting: { judgmentId: string; ticker: string; reason: string }[];
  failed: { judgmentId: string; reason: string }[];
}

/**
 * 계획대로 되돌린다. **자동 판정이 멈춰 있지 않으면 거부한다.**
 *
 * 카드마다 별도 트랜잭션이다 — 하나가 실패해도 앞의 것이 살아 있어야 사고 복구가
 * 중간에서 다시 시작될 수 있다. 전부 한 트랜잭션에 묶으면 100장 중 마지막 한 장의
 * 제약 위반이 앞의 99장을 되돌려 놓는다.
 */
export async function executeBulkRevert(
  prisma: PrismaClient,
  filter: BulkRevertFilter,
  input: { operatorUserId: string; reason: string; cause: RevertCause },
  now = new Date(),
): Promise<BulkRevertResult> {
  if (!(await isJudgmentPaused(prisma, filter.assetClass))) {
    throw new BulkRevertRefused(
      '자동 판정이 멈춰 있지 않습니다 — 먼저 정지시키세요.\n' +
        '멈추지 않고 되돌리면 다음 회차 배치가 같은 데이터로 다시 오판정하고, ' +
        '구매자는 판정이 두 번 뒤집히는 것을 봅니다.',
    );
  }

  const plan = await planBulkRevert(prisma, filter);
  const result: BulkRevertResult = { reverted: [], needsAccounting: [], failed: [] };

  for (const item of plan.items) {
    if (item.blockedBy) {
      result.needsAccounting.push({
        judgmentId: item.judgmentId,
        ticker: item.ticker,
        reason: item.blockedBy,
      });
      continue;
    }
    try {
      await revertJudgment(
        prisma,
        {
          judgmentId: item.judgmentId,
          operatorUserId: input.operatorUserId,
          reason: input.reason,
          cause: input.cause,
        },
        now,
      );
      result.reverted.push(item.judgmentId);
    } catch (e) {
      // 계획 이후 상태가 바뀐 경우(그 사이 지급이 실행됐다) — 계획은 스냅샷이다
      const reason =
        e instanceof JudgmentRevertBlocked ? e.code : e instanceof Error ? e.message : String(e);
      result.failed.push({ judgmentId: item.judgmentId, reason });
    }
  }

  // **일괄 작업 자체를 한 줄로 남긴다.** 카드별 되돌리기도 각자 남지만(revertJudgment),
  // "누가 언제 무슨 범위를 한 번에 되돌렸나"는 그 줄들을 모아도 복원되지 않는다
  await audit(prisma, {
    actor: input.operatorUserId,
    actorType: 'OPERATOR',
    action: 'BULK_REVERT',
    targetType: 'JudgmentRange',
    targetId: `${filter.judgedFrom.toISOString()}~${filter.judgedTo.toISOString()}`,
    before: { matched: plan.items.length },
    after: {
      reverted: result.reverted.length,
      needsAccounting: result.needsAccounting.length,
      failed: result.failed.length,
      assetClass: filter.assetClass ?? 'ALL',
      dataSource: filter.dataSource ?? 'ALL',
    },
    reason: `${input.cause}: ${input.reason}`,
    at: now,
  });

  return result;
}
