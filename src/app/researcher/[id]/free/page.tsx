import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { AppHeader } from "../../../AppHeader";
import { FreeReportForm } from "./FreeReportForm";
import styles from "../../researcher.module.css";

export const dynamic = "force-dynamic";

export default async function NewFreeReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await prisma.researcherProfile.findUnique({ where: { id } });
  if (!profile) notFound();

  return (
    <>
      <AppHeader title="무료 시황 쓰기" backHref={`/researcher/${id}`} />
      <main className={styles.page}>
        <p className={styles.sub}>
          예측 카드 없이 공개하는 시황·증시 글입니다. 홈의 무료 리포트 목록에 바로 노출되며,
          일반 투자자가 리서처를 알게 되는 통로입니다.
        </p>
        <FreeReportForm />
      </main>
    </>
  );
}
