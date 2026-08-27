import { redirect } from "next/navigation";
import {
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
          summary: true,
          content: true,
          priceKrw: true,
          researcher: { select: { user: { select: { penName: true, email: true } } } },
        },
      })
    : null;
  // 무료 시황(가격 0)은 예측 카드가 없어 판매를 멈출 대상이 아니다 — 신고는 자유 입력 쪽으로
  const targetReport = target && target.priceKrw > 0 ? target : null;

  // **본문은 산 사람에게만 보여준다** (마스킹) — 신고자가 본문의 어느 부분이 위반인지
  // 짚으려면 본문을 봤어야 하고, 그건 구매한 사람이다. 안 산 사람은 종전대로 자유 입력.
  const purchased = targetReport
    ? !!(await prisma.purchase.findFirst({
        where: { reportId: targetReport.id, buyerId: userId },
        select: { id: true },
      }))
    : false;
  const reportBody =
    targetReport && purchased
      ? { title: targetReport.title, content: targetReport.content ?? "" }
      : null;
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
              같은 리포트에 여러 신고가 들어오면 <b style={{ color: "var(--text)" }}>가장 먼저
              신고하신 분</b>에게 보상이 갑니다. 검토 결과는 알림으로 안내되며, 보상 지급
              방법은 확인 후 개별로 안내드립니다.
            </p>
          </section>

          {/* 유의사항은 **신고 접수 직전 팝업**으로 옮겼다 (2026-08-27 창업자 지시) —
              진짜 접수 전 마지막 고지가 되어야 눈에 들어온다 (CleanReportForm 의 확인창) */}

          <section>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>신고하기</h2>

            {/* **고지는 폼보다 먼저 온다.** 다 쓴 뒤에 "이미 신고됐습니다"를 보여주면
                그게 진짜 헛수고다 — 문의 창구의 selfServe(답을 먼저 보여주고, 거기서
                끝나면 접수가 일어나지 않게)와 같은 자리, 같은 순서다.

                **건수는 절대 쓰지 않는다.** 누구나 아무 리포트에 신고 버튼을 눌러 상태를
                볼 수 있는데, 거기 "2건 접수됨"이 뜨면 담합하는 쪽이 자기 진도를 잰다 —
                문턱이 3인 걸 아는 사람은 정확히 한 명만 더 부른다. 고지가 공격의
                계기판이 되는 것이라, 밖으로 나가는 것은 있다/없다뿐이다 */}
            {/* '이미 접수된 신고가 있습니다' 안내는 걷었다 (2026-08-27 창업자 지시) —
                신고하려는 사람에게 "남이 이미 했다"를 먼저 보여주면 신고 의욕을 꺾는다.
                선착순 보상 규칙은 위 '보상과 절차'에 상시 문구로 옮겼다.
                단, 내가 이미 신고한 건은 중복 접수를 막아야 하므로 그대로 안내한다 */}
            {notice?.byViewer ? (
              <p className={styles.sub} style={{ marginBottom: 0 }}>
                이미 이 리포트를 신고하셨습니다. 검토 결과는 알림으로 알려드립니다.
              </p>
            ) : (
              <CleanReportForm
                reportId={targetReport?.id}
                fixedTargetName={targetName}
                reportBody={reportBody}
              />
            )}
          </section>
        </div>
      </main>
    </>
  );
}
