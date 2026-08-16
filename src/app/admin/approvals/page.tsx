// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getPendingApprovals } from "@/server/operatorApprovalService";
import { AppHeader } from "../../AppHeader";
import marketStyles from "../../market.module.css";
import styles from "./approvals.module.css";
import { ApprovalList } from "./ApprovalList";

export const dynamic = "force-dynamic";

// 운영자 2인 승인 대기열 (2026-08-16 검토 2차 Q3).
//
// 패스키와 최근성은 "들어오는 것"을 막지만, 이미 들어온 사람이 **실행하는 것**은
// 못 막는다. 악의를 품은 내부자는 정당하게 들어오기 때문이다.
// 그래서 돈이 크게 움직이는 행위는 요청과 승인을 다른 사람이 한다.

export default async function ApprovalsPage() {
  const userId = await getSessionUserId();
  const me = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    : null;
  if (me?.role !== "OPERATOR") {
    return (
      <>
        <AppHeader title="승인 대기열" backHref="/settings" />
        <main className={marketStyles.page}>
          <p className={styles.empty}>운영자만 볼 수 있는 화면입니다.</p>
        </main>
      </>
    );
  }

  const pending = await getPendingApprovals(prisma);

  return (
    <>
      <AppHeader title="승인 대기열" backHref="/settings" />
      <main className={marketStyles.page}>
        <div className={marketStyles.section}>다른 운영자의 승인을 기다리는 요청</div>
        <p className={styles.empty}>
          <strong>요청한 사람은 자기 요청을 승인할 수 없습니다.</strong> 운영자 계정 하나가
          뚫리거나 내부자가 악의를 품어도, 돈이 크게 움직이려면 두 사람이 필요합니다.
        </p>
        <ApprovalList
          initial={pending.map((p) => ({
            id: p.id,
            action: p.action,
            summary: p.summary,
            amountKrw: p.amountKrw,
            requestedBy: p.requestedBy,
            requestedAt: p.requestedAt.toISOString(),
            reason: p.reason,
          }))}
        />
      </main>
    </>
  );
}
