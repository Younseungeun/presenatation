import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { AppHeader } from "../../../AppHeader";
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
    <>
      <AppHeader title="새 리포트 작성" backHref={`/researcher/${id}`} />
      <main className={styles.page}>
        <p className={styles.sub}>
          예측 카드는 게시 시점에 잠깁니다. 게시 후에는 수정·삭제할 수 없고 철회만 가능합니다.
        </p>
        <ReportForm researcherId={id} />
      </main>
    </>
  );
}
