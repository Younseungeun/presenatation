import Link from "next/link";
import { prisma } from "@/server/db";
import { getFreeReports } from "@/server/freeReportService";
import { AppHeader } from "../AppHeader";
import { EmptyState } from "../EmptyState";
import { fmtDate } from "../format";
import { TierChip } from "../TierChip";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

// 무료 시황·증시 리포트 목록. 홈 섹션의 "더 보기" 목적지이자,
// 팔로우 블록의 "무료 글 N편"이 한 사람 것만 걸러 들어오는 자리(?r=).

export default async function FreeReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ r?: string }>;
}) {
  const { r: researcherId } = await searchParams;
  const reports = await getFreeReports(prisma, 50, researcherId);
  const author = researcherId ? reports[0]?.researcherName : null;

  return (
    <>
      <AppHeader
        title={author ? `${author}의 무료 시황` : "무료 시황·증시 리포트"}
        backHref={researcherId ? `/r/${researcherId}` : "/"}
      />
      <main className={styles.page}>
        <p className={styles.sub}>
          리서처가 무료로 공개한 시황입니다. 예측 카드가 없어 판정·환불 대상이 아니며, 누구나
          바로 읽을 수 있습니다.
        </p>

        {reports.length === 0 ? (
          <EmptyState glyph="doc" title="아직 공개된 무료 리포트가 없어요" />
        ) : (
          // 목록에서는 판매로 유도하지 않는다 — 전환은 글을 끝까지 읽은 뒤
          // 본문 하단의 리서처 명함에서 일어난다
          reports.map((r) => (
            <Link key={r.reportId} href={`/report/${r.reportId}`} className={styles.reportCard}>
              <div className={styles.reportTitle}>
                <span className={styles.pill}>무료</span>
                {r.title}
              </div>
              <div className={styles.meta}>
                <span>{r.summary}</span>
              </div>
              <div className={styles.meta}>
                <span>{r.researcherName}</span>
                <TierChip tier={r.tier} />
                {r.careerBadge && <span className={styles.pill}>인증</span>}
                <span>{fmtDate(r.publishedAt)}</span>
              </div>
            </Link>
          ))
        )}
      </main>
    </>
  );
}
