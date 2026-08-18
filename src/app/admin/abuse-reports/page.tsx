// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ABUSE_CATEGORY_LABEL,
  type AbuseCategory,
  getAbuseReports,
  REWARD_QUOTA,
  rewardedCount,
} from "@/server/abuseReportService";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import { EmptyState } from "../../EmptyState";
import styles from "../../researcher/researcher.module.css";
import { ReviewForm } from "./ReviewForm";

export const dynamic = "force-dynamic";

// 클린 리서치 신고 검토 콘솔 — 확인(선착순 보상 대상 판단 포함)·기각.
//
// ⚠ 확인해도 **지급 수단은 아직 없다** (2026-08-18). rewarded 플래그는 "보상 대상"까지만
// 뜻하고, 실제 지급은 운영자가 개별로 안내한다. 쿠폰 발행·사용을 만들면 이 목록이
// 소급 발행의 대상이 된다 — 그래서 대상 표시는 지금부터 남긴다.
// 운영자(role=OPERATOR)가 아니면 존재 자체를 숨긴다 (404).

export default async function AdminAbuseReportsPage() {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const [reports, used] = await Promise.all([getAbuseReports(prisma), rewardedCount(prisma)]);
  const pending = reports.filter((r) => r.status === "PENDING");
  const reviewed = reports.filter((r) => r.status !== "PENDING");

  return (
    <>
      <AppHeader title="신고 검토" backHref="/my" />
      <main className={styles.page}>
        <div className={styles.header}>
          <div>
            <p className={styles.sub}>
              클린 리서치 신고를 검토합니다. 확인하면 선착순 쿼터 안에서 보상 대상으로
              표시되고 신고자에게 알림이 갑니다 — <b>지급은 개별 안내이고 자동으로 나가지
              않습니다.</b> 기각 사유는 반복 무고 제재의 근거로 남습니다. 보상 잔여{" "}
              {Math.max(0, REWARD_QUOTA - used).toLocaleString()}건 /{" "}
              {REWARD_QUOTA}건. <Link href="/admin/judgments">판정 보류 큐 →</Link>
            </p>
          </div>
        </div>

        {pending.length === 0 ? (
          <EmptyState compact glyph="inbox" title="대기 중인 신고가 없어요" />
        ) : (
          pending.map((r) => (
            <div key={r.id} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.cardTitle}>{r.targetName}</div>
                <span className={styles.badge}>
                  {ABUSE_CATEGORY_LABEL[r.category as AbuseCategory] ?? r.category}
                </span>
              </div>
              <div className={styles.meta}>
                <span>신고자 {r.reporterName}</span>
                <span>{new Date(r.createdAt).toLocaleString("ko-KR")}</span>
                {r.reporterRejectedCount > 0 && (
                  <span>⚠ 이 신고자의 기각 이력 {r.reporterRejectedCount}건</span>
                )}
              </div>
              <p className={styles.sub} style={{ whiteSpace: "pre-wrap" }}>
                {r.detail}
              </p>
              <ReviewForm reportId={r.id} />
            </div>
          ))
        )}

        {reviewed.length > 0 && (
          <>
            <div className={styles.header} style={{ marginTop: 24 }}>
              <div className={styles.sub}>처리 완료 {reviewed.length}건</div>
            </div>
            {reviewed.map((r) => (
              <div key={r.id} className={styles.card}>
                <div className={styles.cardTop}>
                  <div className={styles.cardTitle}>{r.targetName}</div>
                  <span className={styles.badge}>
                    {r.status === "CONFIRMED"
                      ? r.rewarded
                        ? "확인 · 보상 대상"
                        : "확인 · 선착순 마감"
                      : "기각"}
                  </span>
                </div>
                <div className={styles.meta}>
                  <span>신고자 {r.reporterName}</span>
                  <span>{ABUSE_CATEGORY_LABEL[r.category as AbuseCategory] ?? r.category}</span>
                  {r.reviewedAt && (
                    <span>검토 {new Date(r.reviewedAt).toLocaleString("ko-KR")}</span>
                  )}
                </div>
                {r.reviewNote && <p className={styles.sub}>사유: {r.reviewNote}</p>}
              </div>
            ))}
          </>
        )}
      </main>
    </>
  );
}
