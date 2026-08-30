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
import { AdminHead } from "../AdminHead";
import a from "../admin.module.css";

export const dynamic = "force-dynamic";

// 신고 보상·처리 이력 — **판단은 여기서 하지 않는다** (2026-08-19).
// 확인·기각은 리포트 검수 화면의 '본문' 탭에서 한다(신고를 끝내려면 본문을 읽어야 한다).
// 여기 남는 것은 판단의 후속, 즉 **약속을 지키는 일**이다.
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
      <AdminHead title="신고 보상·이력" backHref="/admin" />
      <main className={a.page}>
        <div className={a.sech}>
          <div>
            <p className={a.sechDesc}>
              클린 리서치 신고를 검토합니다. 확인하면 선착순 쿼터 안에서 보상 대상으로
              표시되고 신고자에게 알림이 갑니다 — <b>지급은 개별 안내이고 자동으로 나가지
              않습니다.</b> 기각 사유는 반복 무고 제재의 근거로 남습니다. 보상 잔여{" "}
              {Math.max(0, REWARD_QUOTA - used).toLocaleString()}건 /{" "}
              {REWARD_QUOTA}건. <Link href="/admin/compliance?tab=inst">판정 보류 큐 →</Link>
            </p>
          </div>
        </div>

        {/* **판단은 여기서 하지 않는다** (2026-08-19 사용자 지시).
            신고를 판단하려면 그 리포트의 **본문**을 읽어야 하고, 그건 검수 보류 건을
            판단할 때와 같은 재료다 — 그래서 판단은 리포트 검수 화면의 '본문' 탭 한 곳에서만
            한다. 창구가 둘이 되면 같은 질문("이 글을 팔아도 되나")이 두 큐로 쪼개지고,
            어느 쪽이 최신인지 매번 되묻게 된다.
            이 화면에 남는 것은 **약속을 지키는 일**이다: 보상 대상과 처리 이력 */}
        {pending.length > 0 && (
          <div className={a.card}>
            <div className={a.ttl}>검토를 기다리는 신고 {pending.length}건</div>
            <p className={a.hint} style={{ marginBottom: 0 }}>
              판단은 <b>리포트 검수 · 본문 탭</b>의 &ldquo;이용자가 잡은 것&rdquo;에서 합니다 —
              신고를 끝내려면 그 리포트의 본문을 읽어야 하기 때문입니다.{" "}
              <Link href="/admin/compliance?tab=sale">판매 중 탭으로 →</Link>
            </p>
          </div>
        )}
        {pending.length === 0 && (
          <div className={a.empty}>
            <span className={a.dot} />
            대기 중인 신고가 없어요
          </div>
        )}

        {reviewed.length > 0 && (
          <>
            <div className={a.sech} style={{ marginTop: 24 }}>
              <div className={a.hint}>처리 완료 {reviewed.length}건</div>
            </div>
            {reviewed.map((r) => (
              <div key={r.id} className={a.card}>
                <div className={a.row}>
                  <div className={a.ttl}>{r.targetName}</div>
                  <span className={a.chip}>
                    {r.status === "CONFIRMED"
                      ? r.rewarded
                        ? "확인 · 보상 대상"
                        : "확인 · 선착순 마감"
                      : "기각"}
                  </span>
                </div>
                <div className={a.meta}>
                  <span>신고자 {r.reporterName}</span>
                  <span>{ABUSE_CATEGORY_LABEL[r.category as AbuseCategory] ?? r.category}</span>
                  {r.reviewedAt && (
                    <span>검토 {new Date(r.reviewedAt).toLocaleString("ko-KR")}</span>
                  )}
                </div>
                {r.reviewNote && <p className={a.hint}>사유: {r.reviewNote}</p>}
              </div>
            ))}
          </>
        )}
      </main>
    </>
  );
}
