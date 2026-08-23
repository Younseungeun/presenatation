import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import {
  executePayout,
  executeRefund,
  getPendingPayouts,
  getPendingRefunds,
  REFUND_METHODS,
  resolveBankTransferAttempt,
  retryRefundAttempt,
} from '@/server/settlementOpsService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 정산 콘솔: 미실행 환불·지급 지시서 조회 + 실행 기록

const bodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('REFUND'),
    settlementId: z.string().min(1),
    method: z.enum(REFUND_METHODS),
    // 계좌이체는 멱등키가 없어 이 번호가 유일한 중복 방지 수단이다 (서비스가 필수를 강제)
    bankReference: z.string().min(1).max(100).optional(),
  }),
  /**
   * 같은 리포트의 환불을 **한 번 눌러 차례로** 실행한다 (시안 scr-money).
   *
   * 트랜잭션으로 묶지 않는다 — 안에서 PG를 부르기 때문이다(트랜잭션 안 I/O 금지).
   * 그래서 이건 원자적 실행이 아니라 **한 번의 손짓**이고, 건별 결과를 그대로 돌려준다:
   * 한도에 걸리거나 이의가 붙은 건은 그 건만 멈추고 나머지는 나간다. 실패를 삼키면
   * "3건 실행했다"는 화면과 "2건만 나갔다"는 장부가 갈린다.
   */
  z.object({
    kind: z.literal('REFUND_GROUP'),
    settlementIds: z.array(z.string().min(1)).min(2).max(50),
    method: z.enum(REFUND_METHODS),
    bankReference: z.string().min(1).max(100).optional(),
  }),
  // 끝나지 않은 시도를 **같은 멱등키로** 이어받는다 — 새 실행과 반드시 구분해야 한다
  z.object({ kind: z.literal('REFUND_RETRY'), attemptId: z.string().min(1) }),
  // 계좌이체는 재시도가 아니라 **사람이 상태를 확정**한다 (멱등키가 없어 재시도 = 이중 송금)
  z.object({
    kind: z.literal('REFUND_RESOLVE'),
    attemptId: z.string().min(1),
    resolution: z.enum(['SENT', 'NOT_SENT']),
    bankReference: z.string().min(1).max(100).optional(),
  }),
  z.object({
    kind: z.literal('PAYOUT'),
    settlementId: z.string().min(1),
    // **아직 우리에게 안 온 돈일 수 있다.** 결제 직후의 지급은 PG 입금 전이라 회사 돈을
    // 먼저 내주는 것이 된다 — 토스 콘솔에서 입금을 눈으로 확인했을 때만 넘긴다
    confirmedSettled: z.boolean().optional(),
    /** 생체 재확인 표 (1인 운영 모드의 고액 지급) — 생체를 통과한 화면이 방금 받은 1회용 값 */
    recheckToken: z.string().max(200).optional(),
  }),
]);

export async function GET() {
  try {
    await requireOperatorId(prisma);
    const [refunds, payouts] = await Promise.all([
      getPendingRefunds(prisma),
      getPendingPayouts(prisma),
    ]);
    return NextResponse.json({ refunds, payouts });
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    if (body.kind === 'REFUND') {
      await executeRefund(prisma, {
        settlementId: body.settlementId,
        operatorUserId,
        method: body.method,
        bankReference: body.bankReference,
      });
    } else if (body.kind === 'REFUND_GROUP') {
      // **차례로** 실행한다 — 동시에 보내면 일일 한도를 각자 통과해 합계가 한도를 넘는다
      const results: { settlementId: string; ok: boolean; error?: string }[] = [];
      for (const settlementId of body.settlementIds) {
        try {
          await executeRefund(prisma, {
            settlementId,
            operatorUserId,
            method: body.method,
            bankReference: body.bankReference,
          });
          results.push({ settlementId, ok: true });
        } catch (e) {
          // 한 건이 막혀도 멈추지 않는다 — 막힌 이유(이의·쿨다운·한도)는 건마다 다르고,
          // 여기서 중단하면 뒤 건들은 이유 없이 안 나간 채 남는다
          results.push({
            settlementId,
            ok: false,
            error: e instanceof Error ? e.message : '실행 실패',
          });
        }
      }
      return NextResponse.json({
        ok: results.every((r) => r.ok),
        done: results.filter((r) => r.ok).length,
        total: results.length,
        results,
      });
    } else if (body.kind === 'REFUND_RETRY') {
      await retryRefundAttempt(prisma, { attemptId: body.attemptId, operatorUserId });
    } else if (body.kind === 'REFUND_RESOLVE') {
      await resolveBankTransferAttempt(prisma, {
        attemptId: body.attemptId,
        operatorUserId,
        resolution: body.resolution,
        bankReference: body.bankReference,
      });
    } else {
      await executePayout(prisma, {
        settlementId: body.settlementId,
        operatorUserId,
        confirmedSettled: body.confirmedSettled,
        recheckToken: body.recheckToken,
      });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
