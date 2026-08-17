// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import {
  getCooldownHold,
  SETTLEMENT_COOLDOWN_HOURS,
} from "@/server/settlementCooldown";
import { getPendingPayouts, getPendingRefunds } from "@/server/settlementOpsService";
import {
  getApprovedCompensations,
  getPendingCompensationReviews,
} from "@/server/compensationService";
import { DUAL_APPROVAL_THRESHOLD_KRW } from "@/domain/operatorApproval";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import { EmptyState } from "../../EmptyState";
import { fmtDayMonth as fmtDate } from "../../format";
import { StatusChip } from "../../StatusChip";
import styles from "../../researcher/researcher.module.css";
import { ExecuteButton } from "./ExecuteButton";
import { CompensationExecute, CompensationReview } from "./CompensationActions";

export const dynamic = "force-dynamic";

// 운영자 정산 콘솔: 판정이 만든 환불·지급 지시서를 실행하고 기록한다.
// PG 취소·지급이체 자동화 전의 수동 운영 화면 — 비운영자에게는 404.

export default async function AdminSettlementsPage() {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const [refunds, payouts, hold, compensationReviews, compensationsToExecute] = await Promise.all([
    getPendingRefunds(prisma),
    getPendingPayouts(prisma),
    getCooldownHold(prisma),
    getPendingCompensationReviews(prisma),
    getApprovedCompensations(prisma),
  ]);
  // 보상 두 목록의 리서처 표시명 — 지시서에는 userId만 있다
  const compUserIds = [
    ...new Set([
      ...compensationReviews.map((g) => g.researcherUserId),
      ...compensationsToExecute.map((c) => c.researcherUserId),
    ]),
  ];
  const compNames = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: compUserIds } },
        select: { id: true, penName: true, email: true },
      })
    ).map((u) => [u.id, u.penName ?? u.email]),
  );
  const refundTotal = refunds.reduce((a, s) => a + s.buyerRefundKrw, 0);
  const payoutTotal = payouts.reduce((a, s) => a + s.researcherPayoutKrw, 0);

  return (
    <>
      <AppHeader title="정산 지시서" backHref="/my" />
      <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.sub}>
            판정이 확정한 환불·지급을 실행하고 기록합니다. 실행 즉시 당사자에게 알림이
            갑니다. <Link href="/admin/judgments">판정 보류 큐 →</Link>{" "}
            {/* 이의가 걸린 건은 여기 목록에서 아예 빠진다 — 왜 안 보이는지 알 길이
                이 링크뿐이라, 없으면 "지급이 사라졌다"로 읽힌다 */}
            <Link href="/admin/disputes">판정 이의 →</Link>
          </p>
        </div>
      </div>

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>미실행 환불</span>
          <span className={styles.statValue}>
            {refunds.length}건 · {refundTotal.toLocaleString()}원
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>미지급 정산</span>
          <span className={styles.statValue}>
            {payouts.length}건 · {payoutTotal.toLocaleString()}원
          </span>
        </div>
        {/* **큐에서 빼는 것과 숨기는 것은 다르다.** 쿨다운 건은 누를 수 없으니 목록에
            그리지 않지만, 존재까지 안 보이면 운영자가 "오늘 나갈 돈이 없다"고 착각한다 */}
        {hold.count > 0 && (
          <div className={styles.stat}>
            <span className={styles.statLabel}>대기 중 ({SETTLEMENT_COOLDOWN_HOURS}시간)</span>
            <span className={styles.statValue}>
              {hold.count}건 · {hold.amountKrw.toLocaleString()}원
            </span>
          </div>
        )}
      </div>

      {hold.count > 0 && hold.nextExecutableAt && (
        <p className={styles.sub}>
          판정 직후 {SETTLEMENT_COOLDOWN_HOURS}시간은 되돌릴 수 있도록 에스크로에 묶어
          둡니다 — 잘못된 판정에 돈이 먼저 나가면 되돌릴 방법이 없습니다. 가장 빠른 건이{" "}
          {fmtDate(hold.nextExecutableAt)}에 풀립니다.{" "}
          <Link href="/admin/judgments">지금이 되돌릴 수 있는 시간입니다 →</Link>
        </p>
      )}

      <h3>환불 지시서 (구매자 현금 환불)</h3>
      {refunds.length === 0 ? (
        <EmptyState compact glyph="inbox" title="실행할 환불이 없어요" />
      ) : (
        refunds.map((s) => (
          <div key={s.id} className={styles.card}>
            <div className={styles.cardTop}>
              <div className={styles.cardTitle}>
                {s.buyerRefundKrw.toLocaleString()}원 →{" "}
                {s.purchase.buyer.penName ?? s.purchase.buyer.email}
              </div>
              <StatusChip
                status={s.outcome === "MISS" ? "MISS" : "UNDECIDABLE"}
                label={s.outcome === "MISS" ? "예측 실패" : "판정 불가"}
              />
            </div>
            <div className={styles.meta}>
              <span>{s.purchase.report.title}</span>
              <span>판정 {fmtDate(s.settledAt)}</span>
              <span>결제 {fmtDate(s.purchase.paidAt)}</span>
            </div>
            <ExecuteButton
              kind="REFUND"
              settlementId={s.id}
              stuckAttemptId={s.refundAttempts[0]?.id}
              stuckAttemptMethod={s.refundAttempts[0]?.method}
            />
          </div>
        ))
      )}

      <h3>지급 지시서 (리서처 정산금)</h3>
      {payouts.length === 0 ? (
        <EmptyState compact glyph="inbox" title="지급할 정산이 없어요" />
      ) : (
        payouts.map((s) => {
          // 금액이 클수록 눈에 걸리게 (2026-08-17 사용자 확정 — 1인 운영에서 고액 지급
          // 2인 승인의 "큰돈은 주의해서 보자"는 취지를 색이 잇는다. 검수 큐의 지연
          // 강조와 같은 문법: 좌측 컬러 보더). 문턱은 2인 승인 문턱과 그 절반
          const emphasis =
            s.researcherPayoutKrw >= DUAL_APPROVAL_THRESHOLD_KRW
              ? "var(--neg)"
              : s.researcherPayoutKrw >= DUAL_APPROVAL_THRESHOLD_KRW / 2
                ? "var(--warn)"
                : null;
          return (
          <div
            key={s.id}
            className={styles.card}
            style={emphasis ? { borderLeft: `4px solid ${emphasis}` } : undefined}
          >
            <div className={styles.cardTop}>
              <div className={styles.cardTitle} style={emphasis ? { color: emphasis } : undefined}>
                {s.researcherPayoutKrw.toLocaleString()}원 →{" "}
                {s.purchase.report.researcher.user.penName ??
                  s.purchase.report.researcher.user.email}
              </div>
              <StatusChip status="HIT" label="적중 정산" />
            </div>
            {emphasis === "var(--neg)" && (
              <p className={styles.sub} style={{ color: emphasis }}>
                큰 금액입니다 — 실행 전에 리포트·판정·계좌를 한 번 더 확인하세요.
              </p>
            )}
            <div className={styles.meta}>
              <span>{s.purchase.report.title}</span>
              <span>수수료 {s.platformFeeKrw.toLocaleString()}원</span>
              <span>판정 {fmtDate(s.settledAt)}</span>
            </div>
            <ExecuteButton kind="PAYOUT" settlementId={s.id} />
          </div>
          );
        })
      )}

      {/* ── 플랫폼 귀책 보상 (2026-08-18 배선 — 그전에는 확정·실행할 문이 없었다) ──
          이 돈은 에스크로 위탁이 아니라 **플랫폼 자본**이다. 물어야 하는 것은
          "그 예측이 맞았을까"가 아니라 "판정을 못 한 것이 우리 탓인가"뿐이다 */}
      {(compensationReviews.length > 0 || compensationsToExecute.length > 0) && (
        <>
          <h3>플랫폼 귀책 보상</h3>
          <p className={styles.sub}>
            우리 사정으로 판정하지 못해 전액 환불로 닫힌 카드입니다. 구매자는 이미
            환불받았고, 리서처는 여기서 확정해야 받습니다 (플랫폼 자본 지출).
          </p>

          {compensationReviews.map((g) => (
            <div key={g.predictionCardId} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.cardTitle}>
                  {g.totalKrw.toLocaleString()}원 →{" "}
                  {compNames.get(g.researcherUserId) ?? g.researcherUserId}
                </div>
                <StatusChip status="PENDING_REVIEW" label="귀책 확정 대기" />
              </div>
              <div className={styles.meta}>
                <span>{g.rows[0]?.purchase.report.title}</span>
                <span>사유 {g.causeLabel}</span>
                <span>구매 {g.rows.length}건</span>
                <span>발생 {fmtDate(g.createdAt)}</span>
              </div>
              {/* 자동 제외 규칙을 만들지 않는 대신 이 숫자를 사람 앞에 놓는다 —
                  같은 N회가 우리 피드 장애를 반복해 겪은 정직한 리서처일 수 있다 */}
              {g.researcherUnjudgeableCards >= 2 && (
                <p className={styles.sub}>
                  이 리서처의 최근 180일 시세 미확보 판정 불가: {g.researcherUnjudgeableCards}
                  장 (이 건 포함) — 반복이면 종목 선택 패턴을 함께 보세요.
                </p>
              )}
              <CompensationReview predictionCardId={g.predictionCardId} />
            </div>
          ))}

          {compensationsToExecute.map((c) => (
            <div key={c.id} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.cardTitle}>
                  {c.amountKrw.toLocaleString()}원 →{" "}
                  {compNames.get(c.researcherUserId) ?? c.researcherUserId}
                </div>
                <StatusChip status="HIT" label="승인됨 — 이체 대기" />
              </div>
              <div className={styles.meta}>
                <span>{c.purchase.report.title}</span>
                {c.reviewedAt && <span>확정 {fmtDate(c.reviewedAt)}</span>}
              </div>
              <p className={styles.sub}>
                은행에서 이체를 먼저 실행한 뒤, 참조번호로 기록을 닫아주세요. 실행 직전
                지문·얼굴 확인이 있습니다.
              </p>
              <CompensationExecute compensationId={c.id} />
            </div>
          ))}
        </>
      )}
      </main>
    </>
  );
}
