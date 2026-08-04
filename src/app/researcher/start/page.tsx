import Link from "next/link";
import { redirect } from "next/navigation";
import { LEGAL_DOCS } from "@/domain/legalDocs";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import styles from "../researcher.module.css";
import { ActivateForm } from "./ActivateForm";

export const dynamic = "force-dynamic";

// 리서처 전환 동의 화면: 리서처 이용계약에 동의해야 활동을 시작할 수 있다.
export default async function ResearcherStartPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login?next=/researcher/start");

  const profile = await prisma.researcherProfile.findUnique({ where: { userId } });
  if (profile) redirect(`/researcher/${profile.id}`);

  const doc = LEGAL_DOCS.RESEARCHER_AGREEMENT;

  return (
    <>
      <AppHeader title="리서처 시작하기" backHref="/my" />
      <main className={styles.page} style={{ maxWidth: 560 }}>
      <p className={styles.sub}>
        리포트를 판매하려면 리서처 이용계약에 동의해야 합니다. 예측 카드는 게시 후 수정·삭제할
        수 없고, 판정 결과가 성과 기록으로 공개됩니다.
      </p>

      <div className={styles.card} style={{ marginTop: 8 }}>
        <div className={styles.cardTop}>
          <div className={styles.cardTitle}>{doc.title} 요약</div>
          {doc.draft && (
            <span className={`${styles.badge} ${styles.undecidable}`}>검토 전 초안</span>
          )}
        </div>
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13.5, color: "var(--text-weak)" }}>
          {doc.sections.slice(0, 3).map((s) => (
            <li key={s.heading} style={{ marginBottom: 6 }}>
              <strong>{s.heading}</strong>
            </li>
          ))}
        </ul>
        <Link className={styles.hint} href="/terms/RESEARCHER_AGREEMENT" target="_blank">
          전문 보기 →
        </Link>
      </div>

      <ActivateForm />
      </main>
    </>
  );
}
