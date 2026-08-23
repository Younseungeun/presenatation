import { redirect } from "next/navigation";
import {
  DAILY_REPORT_LIMIT,
  REWARD_QUOTA,
  getReportAbuseNotice,
  rewardedCount,
} from "@/server/abuseReportService";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../AppHeader";
import styles from "../market.module.css";
import { CleanReportForm } from "./CleanReportForm";

export const dynamic = "force-dynamic";

// 클린 리서치 신고 — 1:1 상담·투자 권유 등 유사투자자문업 범위를 넘는 행위 신고 안내·접수.
// 출시 초기 자동 감시가 성숙하기 전까지 이용자 신고가 1차 탐지망이다 (확인 시 선착순 보상).
//
// ⚠ **지급 수단을 문구에 적지 않는다** (2026-08-18): 쿠폰 발행·사용 기능이 아직 없다.
// 예전 문구는 "리포트 구매 쿠폰을 드립니다"였는데, 그건 만들지 않은 것을 약속하는 말이었다.
// 보상 자체는 실제로 한다(선착순 쿼터는 DB가 세고, 운영자가 개별로 안내). 쿠폰이 생기면
// 그때 문구를 되돌린다 — 수단을 먼저 짓고 말을 나중에 하는 순서다.

const TARGETS = [
  "1:1 상담·개별 연락 유도 — 오픈채팅, 전화, DM 등으로 개별 상담을 권하는 행위",
  "수익 보장·투자 권유 — \"무조건 오른다\", \"지금 사라\" 등 권유·보장성 표현",
  "외부 채널 유인 — 리딩방·텔레그램 등 플랫폼 밖 유료 채널로 데려가는 행위",
  "그 밖의 이용약관·법령 위반이 의심되는 행위",
];

export default async function CleanPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const used = await rewardedCount(prisma);
  const remaining = Math.max(0, REWARD_QUOTA - used);

  // 리포트 화면의 신고 버튼으로 들어온 경우 — 대상이 정해져 있고, 그래서
  // "이미 신고된 리포트인가"를 **폼을 열기 전에** 답할 수 있다
  const { report: reportIdParam } = await searchParams;
  const target = reportIdParam
    ? await prisma.report.findUnique({
        where: { id: reportIdParam },
        select: {
          id: true,
          title: true,
          priceKrw: true,
          researcher: { select: { user: { select: { penName: true, email: true } } } },
        },
      })
    : null;
  // 무료 시황(가격 0)은 예측 카드가 없어 판매를 멈출 대상이 아니다 — 신고는 자유 입력 쪽으로
  const targetReport = target && target.priceKrw > 0 ? target : null;
  const notice = targetReport
    ? await getReportAbuseNotice(prisma, targetReport.id, userId)
    : null;
  const targetName = targetReport
    ? `${targetReport.researcher.user.penName ?? targetReport.researcher.user.email} · ${targetReport.title}`
    : undefined;

  return (
    <>
      <AppHeader
        title="클린 리서치 신고"
        backHref={targetReport ? `/report/${targetReport.id}` : "/"}
      />
      <main className={styles.page} style={{ maxWidth: 720 }}>
        <p className={styles.sub}>
          인투빌의 모든 리포트는 불특정 다수를 위한 공개 분석이어야 합니다. 아래 행위를
          발견하면 신고해 주세요 — 확인된 신고에는 선착순으로 보상을 드립니다.
        </p>

        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
          <section>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>신고 대상 행위</h2>
            <ul
              style={{
                fontSize: 14,
                lineHeight: 1.7,
                color: "var(--text-weak)",
                paddingLeft: 18,
                display: "flex",
                flexDirection: "column",
                gap: 4,
              }}
            >
              {TARGETS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </section>

          <section>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>보상과 절차</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-weak)" }}>
              접수된 신고는 운영자가 직접 검토하며, 위반이 확인된 신고에 한해 선착순{" "}
              {REWARD_QUOTA}건까지 보상을 드립니다 (현재 잔여 {remaining.toLocaleString()}건).
              검토 결과는 알림으로 안내되며, 보상 지급 방법은 확인 후 개별로 안내드립니다.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>유의사항</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-weak)" }}>
              신고는 1인당 하루 {DAILY_REPORT_LIMIT}건까지 접수할 수 있습니다. 사실과 다른
              내용을 고의로 신고하거나 허위 신고를 반복하면 보상 대상에서 제외되고 서비스
              이용이 제한될 수 있습니다.
            </p>
          </section>

          <section>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>신고하기</h2>

            {/* **고지는 폼보다 먼저 온다.** 다 쓴 뒤에 "이미 신고됐습니다"를 보여주면
                그게 진짜 헛수고다 — 문의 창구의 selfServe(답을 먼저 보여주고, 거기서
                끝나면 접수가 일어나지 않게)와 같은 자리, 같은 순서다.

                **건수는 절대 쓰지 않는다.** 누구나 아무 리포트에 신고 버튼을 눌러 상태를
                볼 수 있는데, 거기 "2건 접수됨"이 뜨면 담합하는 쪽이 자기 진도를 잰다 —
                문턱이 3인 걸 아는 사람은 정확히 한 명만 더 부른다. 고지가 공격의
                계기판이 되는 것이라, 밖으로 나가는 것은 있다/없다뿐이다 */}
            {notice?.byViewer ? (
              <p className={styles.sub} style={{ marginBottom: 0 }}>
                이미 이 리포트를 신고하셨습니다. 검토 결과는 알림으로 알려드립니다.
              </p>
            ) : (
              <>
                {notice?.alreadyReported && (
                  <div
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 12,
                      padding: "14px 16px",
                      marginBottom: 14,
                      fontSize: 13.5,
                      lineHeight: 1.7,
                      color: "var(--text-weak)",
                    }}
                  >
                    <strong style={{ color: "var(--text)" }}>
                      이미 접수된 신고가 있는 리포트입니다.
                    </strong>
                    <br />
                    {/* 두 번째 신고자를 막으면 안 된다 — 막으면 누적이 안 쌓이고,
                        누적이 안 쌓이면 정작 판매 중단이 걸리지 않는다. 그래서 닫는 말이
                        아니라 **정직하게 여는 말**을 쓴다: 보상은 없지만 효과는 있다 */}
                    보상은 먼저 신고하신 분에게 갑니다. 다만 같은 리포트에 신고가 겹치면
                    저희가 더 빨리 움직입니다 — 남겨 주시면 그 판단에 그대로 들어갑니다.
                  </div>
                )}
                <CleanReportForm reportId={targetReport?.id} fixedTargetName={targetName} />
              </>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
