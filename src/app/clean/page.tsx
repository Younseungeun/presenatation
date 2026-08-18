import { redirect } from "next/navigation";
import {
  DAILY_REPORT_LIMIT,
  REWARD_QUOTA,
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

export default async function CleanPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const used = await rewardedCount(prisma);
  const remaining = Math.max(0, REWARD_QUOTA - used);

  return (
    <>
      <AppHeader title="클린 리서치 신고" backHref="/" />
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
            <CleanReportForm />
          </section>
        </div>
      </main>
    </>
  );
}
