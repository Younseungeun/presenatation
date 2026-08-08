import Link from "next/link";
import { prisma } from "@/server/db";
import { getFreeReports } from "@/server/freeReportService";
import { AppHeader } from "../AppHeader";
import { EmptyState } from "../EmptyState";
import { fmtDate } from "../format";
import { TierChip } from "../TierChip";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

// 무료 시황·증시 리포트 전체 목록. 홈 섹션의 "더 보기" 목적지.

export default async function FreeReportsPage() {
  const reports = await getFreeReports(prisma, 50);

  return (
    <>
      <AppHeader title="무료 시황·증시 리포트" backHref="/" />
      <main className={styles.page}>
        <p className={styles.sub}>
          리서처가 무료로 공개한 시황입니다. 예측 카드가 없어 판정·환불 대상이 아니며, 누구나
          바로 읽을 수 있습니다.
        </p>

        {reports.length === 0 ? (
          <EmptyState glyph="doc" title="아직 공개된 무료 리포트가 없어요" />
        ) : (
          reports.map((r) => (
            // 글과 리서처는 서로 다른 목적지라 링크를 나눈다 (링크 중첩은 불가능하기도 하다).
            // 글을 읽으러 온 사람과 사람을 보러 온 사람이 같은 목록에 있다
            <div key={r.reportId} className={styles.reportCard}>
              <Link href={`/report/${r.reportId}`} className={styles.freeBody}>
                <div className={styles.reportTitle}>
                  <span className={styles.pill}>무료</span>
                  {r.title}
                </div>
                <div className={styles.meta}>
                  <span>{r.summary}</span>
                </div>
              </Link>
              <Link href={`/r/${r.researcherId}`} className={styles.freeAuthor}>
                <span className={styles.freeAuthorName}>{r.researcherName}</span>
                <TierChip tier={r.tier} />
                {r.careerBadge && <span className={styles.pill}>인증</span>}
                <span className={styles.freeAuthorDate}>{fmtDate(r.publishedAt)}</span>
                {r.sellingCount > 0 && (
                  <span className={styles.freeAuthorCta}>판매 중 {r.sellingCount}장 →</span>
                )}
              </Link>
            </div>
          ))
        )}
      </main>
    </>
  );
}
