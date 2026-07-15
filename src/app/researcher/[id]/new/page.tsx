import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { ReportForm } from "./ReportForm";
import styles from "../../researcher.module.css";

export const dynamic = "force-dynamic";

export default async function NewReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const researcher = await prisma.researcherProfile.findUnique({ where: { id } });
  if (!researcher) notFound();

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <h1>새 리포트 작성</h1>
        <Link className={styles.hint} href={`/researcher/${id}`}>
          ← 대시보드
        </Link>
      </div>
      <p className={styles.sub}>
        예측 카드는 게시 시점에 잠깁니다. 게시 후에는 수정·삭제할 수 없고 철회만 가능합니다.
      </p>
      <ReportForm researcherId={id} />
    </main>
  );
}
