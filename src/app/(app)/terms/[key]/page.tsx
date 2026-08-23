import { notFound } from "next/navigation";
import { getLegalDoc } from "@/domain/legalDocs";
import { AppHeader } from "../../AppHeader";
import styles from "../../market.module.css";

export function generateStaticParams() {
  return [
    { key: "TERMS_OF_SERVICE" },
    { key: "PRIVACY_POLICY" },
    { key: "RESEARCHER_AGREEMENT" },
  ];
}

export default async function TermsDocPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const doc = getLegalDoc(key);
  if (!doc) notFound();

  return (
    <>
      <AppHeader title={doc.title} backHref="/terms" />
      <main className={styles.page} style={{ maxWidth: 720 }}>
      <p className={styles.sub}>
        버전 {doc.version} · 시행일 {doc.effectiveDate}
        {doc.draft && " · 변호사 검토 전 초안"}
      </p>

      {doc.draft && (
        <div className={styles.locked} style={{ marginTop: 12 }}>
          본 문서는 변호사 검토 전 초안입니다. 확정 문구로 교체될 예정이며, 실제 계약 효력은
          확정본을 따릅니다.
        </div>
      )}

      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 20 }}>
        {doc.sections.map((s) => (
          <section key={s.heading}>
            <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>{s.heading}</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text-weak)" }}>{s.text}</p>
          </section>
        ))}
      </div>
      </main>
    </>
  );
}
