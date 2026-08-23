import { ASSET_CLASSES } from '@/domain/constants';
import type { PrismaClient } from '@prisma/client';
import { getAbuseQueueSummary, getAbuseReports, groupAbuseReports } from './abuseReportService';
import { getPendingCompensationReviews } from './compensationService';
import { getPendingComplianceReviews } from './complianceService';
import { getOpenDisputes, getUpheldPendingRevert } from './judgmentDisputeService';
import { getManualJudgmentQueue } from './manualJudgmentService';
import { getOpsMetrics } from './opsMetrics';
import { getPendingApprovals, isSoloOperatorMode } from './operatorApprovalService';
import { listFrozenAccounts } from './payoutAccountService';
import { getPendingPayouts, getPendingRefunds } from './settlementOpsService';
import { getPauseState } from './judgmentPause';
import { readHeartbeat } from './schedulerHealth';

// 관리자 5화면의 큐 집계 — **한 곳에서 센다.**
//
// 탭바 배지·홈 타일·각 화면 머리가 전부 같은 숫자를 말해야 한다. 화면마다 따로 세면
// 어느 것이 맞는지 매번 되묻게 되고, 실제로 그런 상태였다(대시보드만 세고 나머지는 안 셌다).
//
// ── 색은 개수가 아니라 **급함**이 정한다 ────────────────────────
// 묻는 것은 하나다: 지금 안 하면 무슨 일이 생기나.
//   빨강 = 심대하다 (돈이 잘못 나감 · 판정이 멈춤 · 위반이 지금도 팔림)
//   노랑 = 해야 하지만 여유가 있다
//   초록 = 정상·완료
// 그래서 "3건이니까 빨강"이 아니라 **무엇이 3건인지**를 본다.

export type QueueTone = 'neg' | 'warn' | 'calm';

export interface AdminQueues {
  report: { total: number; tone: QueueTone; holds: number; abuseGroups: number; suspended: number; manual: number };
  money: { total: number; tone: QueueTone; payouts: number; refunds: number; compensations: number; disputes: number; waitingKrw: number };
  sec: { total: number; tone: QueueTone; frozen: number; approvals: number; solo: boolean; tickets: number; mismatches: number };
  status: { total: number; tone: QueueTone; alerts: number; p0: number };
  /**
   * 확성기 배지 — 답을 기다리는 **이용자 문의(SupportTicket)** 수.
   *
   * 신고(AbuseReport)를 세지 않는다. 신고는 리포트 타일이 이미 세고 있어 같은 숫자가
   * 두 자리에 뜨고, 무엇보다 **성격이 다르다**: 신고는 남의 글에 대한 제보라 처리가
   * 판단이고, 문의는 본인이 막혀서 온 것이라 처리가 답장이다.
   */
  inbox: number;
}

export async function getAdminQueues(
  prisma: PrismaClient,
  now = new Date(),
): Promise<AdminQueues> {
  const [
    holds,
    abuseRows,
    abuseSummary,
    manual,
    payouts,
    refunds,
    compensations,
    disputes,
    pendingRevert,
    frozen,
    approvals,
    solo,
    metrics,
    openTickets,
    secTickets,
    mismatches,
    pause,
    beat,
  ] = await Promise.all([
    getPendingComplianceReviews(prisma),
    getAbuseReports(prisma),
    getAbuseQueueSummary(prisma),
    getManualJudgmentQueue(prisma, now),
    getPendingPayouts(prisma, now),
    getPendingRefunds(prisma, now),
    getPendingCompensationReviews(prisma, now),
    getOpenDisputes(prisma),
    getUpheldPendingRevert(prisma),
    listFrozenAccounts(prisma),
    getPendingApprovals(prisma, now),
    isSoloOperatorMode(prisma),
    getOpsMetrics(prisma, now),
    prisma.supportTicket.count({ where: { status: 'OPEN' } }),
    prisma.supportTicket.count({ where: { status: 'OPEN', desk: 'security' } }),
    prisma.payoutAccount.count({ where: { status: 'HOLDER_MISMATCH' } }),
    getPauseState(prisma),
    readHeartbeat(prisma, now),
  ]);

  const abuseGroups = groupAbuseReports(abuseRows.filter((r) => r.status === 'PENDING'));
  const alerts = metrics.filter((m) => m.alert).length;
  const pausedCount = ASSET_CLASSES.filter((c) => pause.global || (pause.byAssetClass[c] ?? false)).length;

  return {
    report: {
      total: holds.length + abuseGroups.length + manual.length,
      // **판매가 멈춘 리포트가 빨강의 유일한 근거다** — 리서처가 지금 이 순간
      // 복구되지 않는 판매 기간을 잃고 있다. 검수 보류는 아직 아무도 못 샀으므로 노랑이다
      tone: abuseSummary.suspendedReports > 0 ? 'neg' : holds.length + manual.length > 0 ? 'warn' : 'calm',
      holds: holds.length,
      abuseGroups: abuseGroups.length,
      suspended: abuseSummary.suspendedReports,
      manual: manual.length,
    },
    money: {
      total: payouts.length + refunds.length + compensations.length + disputes.length + pendingRevert.length,
      // **되돌릴 판정(이의)이 빨강이다** — 구매자가 돈만 잃은 상태로 기다린다.
      // 실행 대기 지시서는 판정이 끝나 실행만 남은 것이라 급하지 않다
      tone: disputes.length + pendingRevert.length > 0 ? 'neg'
        : payouts.length + refunds.length + compensations.length > 0 ? 'warn' : 'calm',
      payouts: payouts.length,
      refunds: refunds.length,
      compensations: compensations.length,
      disputes: disputes.length + pendingRevert.length,
      // 홈 타일이 '얼마가 대기 중인가'를 말한다 — 건수는 크기를 말하지 못한다
      waitingKrw:
        payouts.reduce((a, x) => a + x.researcherPayoutKrw, 0) +
        refunds.reduce((a, x) => a + x.buyerRefundKrw, 0),
    },
    sec: {
      // **동결은 세지 않는다** — 본인이 잠근 것이라 두는 것이 정상이고 '할 일'이 아니다.
      // 세면 매일 같은 숫자가 타일에 앉아 있어 진짜 할 일이 생겨도 안 늘어난 것처럼 보인다
      total: secTickets + mismatches + (solo ? 0 : approvals.length),
      // **동결은 돈이 묶인 채 사람을 기다린다** — 본인 확인이 끝나야 풀린다
      // 명의 불일치가 빨강이다 — 그 계좌로는 한 푼도 안 나가는 채로 사람을 기다린다
      tone: mismatches > 0 ? 'neg' : secTickets + (solo ? 0 : approvals.length) > 0 ? 'warn' : 'calm',
      frozen: frozen.length,
      approvals: solo ? 0 : approvals.length,
      solo,
      tickets: secTickets,
      mismatches,
    },
    status: {
      total: alerts + pausedCount + (beat.stale || beat.stuck ? 1 : 0),
      // 경보는 기계가 아프다는 신호다 — 켜져 있으면 급하다
      tone: pausedCount > 0 || beat.stale || beat.stuck ? 'neg' : alerts > 0 ? 'warn' : 'calm',
      alerts,
      // P0 = 판정이 멈췄거나 스케줄러가 죽은 것. 지표 경보와 급함이 다르다
      p0: pausedCount + (beat.stale || beat.stuck ? 1 : 0),
    },
    inbox: openTickets,
  };
}
