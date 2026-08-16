// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import Link from "next/link";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getPendingApprovals, isSoloOperatorMode } from "@/server/operatorApprovalService";
import { listFrozenAccounts } from "@/server/payoutAccountService";
import { getManualJudgmentQueue } from "@/server/manualJudgmentService";
import { getOpenDisputes, getUpheldPendingRevert } from "@/server/judgmentDisputeService";
import { getPendingComplianceReviews } from "@/server/complianceService";
import { getPendingCompensationReviews } from "@/server/compensationService";
import { getPendingPayouts, getPendingRefunds } from "@/server/settlementOpsService";
import { getOpsMetrics } from "@/server/opsMetrics";
import { AppHeader } from "../AppHeader";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

// 관리자 홈 (2026-08-17 사용자 확정 구조) — **로그인하면 여기가 첫 화면이다.**
//
// 운영자의 하루는 "어느 큐에 몇 건이 기다리나"로 시작한다. 설정 메뉴 속 링크
// 목록으로는 건수를 보려고 화면을 일곱 번 들어가야 했다 — 여기서는 숫자가
// 먼저 보이고, 0인 큐는 눌러볼 이유가 없다는 것까지 화면이 말해 준다.
//
// **사람을 기다리는 건수가 위, 기록·설정이 아래.** 순서가 곧 우선순위다.

function Row({ href, label, count, sub }: { href: string; label: string; count?: number; sub?: string }) {
  return (
    <Link href={href} className={styles.row}>
      <div className={styles.rowMain}>
        <div className={styles.rowName}>
          {label}
          {count !== undefined && count > 0 && (
            <span style={{ marginLeft: 8, fontWeight: 800 }}>{count}건</span>
          )}
        </div>
        {sub && <div className={styles.rowSub}>{sub}</div>}
      </div>
      <span className={styles.rowArrow} aria-hidden="true">›</span>
    </Link>
  );
}

export default async function AdminHomePage() {
  const userId = await getSessionUserId();
  const me = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true, penName: true, email: true } })
    : null;
  if (me?.role !== "OPERATOR") {
    return (
      <>
        <AppHeader title="운영" backHref="/" />
        <main className={styles.page}>
          <p style={{ padding: 16 }}>운영자만 볼 수 있는 화면입니다.</p>
        </main>
      </>
    );
  }

  const now = new Date();
  const [solo, approvals, frozen, manualQueue, disputes, pendingRevert, holds, compensations, payouts, refunds, metrics] =
    await Promise.all([
      isSoloOperatorMode(prisma),
      getPendingApprovals(prisma, now),
      listFrozenAccounts(prisma),
      getManualJudgmentQueue(prisma, now),
      getOpenDisputes(prisma),
      getUpheldPendingRevert(prisma),
      getPendingComplianceReviews(prisma),
      getPendingCompensationReviews(prisma, now),
      getPendingPayouts(prisma, now),
      getPendingRefunds(prisma, now),
      getOpsMetrics(prisma, now),
    ]);
  const alerts = metrics.filter((m) => m.alert).length;

  return (
    <>
      <AppHeader title="운영" backHref="/" />
      <main className={styles.page}>
        <div className={styles.section}>사람을 기다리는 일</div>
        <div className={styles.list}>
          {/* 1인 운영 모드에서는 승인이라는 행위 자체가 없다 — 두 번째 사람 자리를
              실행 직전 생체 재확인이 대신한다. 운영자가 2명이 되면 이 줄이 되살아난다 */}
          {!solo && (
            <Row href="/admin/approvals" label="승인 대기열" count={approvals.length} sub="2인 승인 — 동결 해제·고액 지급·판정" />
          )}
          <Row href="/admin/frozen" label="정산 동결" count={frozen.length} sub="본인이 신고한 계정 — 확인 후 해제" />
          <Row href="/admin/judgments" label="수동 판정" count={manualQueue.length} sub="기계가 못 매긴 카드" />
          <Row href="/admin/disputes" label="판정 이의" count={disputes.length + pendingRevert.length} sub="접수된 건은 정산이 멈춰 있다" />
          <Row href="/admin/compliance" label="검수 보류" count={holds.length} sub="게시를 기다리는 리포트" />
          <Row href="/admin/settlements" label="지급·환불 실행" count={payouts.length + refunds.length} sub="쿨다운이 끝난 지시서" />
          {compensations.length > 0 && (
            <Row href="/admin/settlements" label="보상 확정 대기" count={compensations.length} sub="플랫폼 귀책 — 사람이 확정해야 나간다" />
          )}
        </div>

        <div className={styles.section}>상태</div>
        <div className={styles.list}>
          <Row
            href="/admin/health"
            label="운영 건강"
            count={alerts}
            sub={alerts > 0 ? "경고가 켜진 지표가 있습니다" : "모든 지표 정상"}
          />
          <Row href="/admin/abuse-reports" label="신고 검토" sub="클린 리서치 신고" />
          <Row href="/admin/settings" label="운영 설정" sub="시장 규모 띠지 등" />
        </div>

        <div className={styles.section}>이용자 화면</div>
        <div className={styles.list}>
          <Row href="/" label="앱 화면으로" sub="홈·리더보드 — 이용자가 보는 그대로" />
        </div>
      </main>
    </>
  );
}
