import Link from "next/link";
import { LEGAL_DOCS, LEGAL_DOC_KEYS } from "@/domain/legalDocs";
import styles from "../market.module.css";

export default function TermsIndexPage() {
  return (
    <main className={styles.page} style={{ maxWidth: 640 }}>
      <h1 className={styles.h1}>약관·정책</h1>
      <p className={styles.sub}>서비스 이용에 적용되는 약관과 정책입니다.</p>

      <div className={styles.list} style={{ marginTop: 16 }}>
        {LEGAL_DOC_KEYS.map((key) => {
          const doc = LEGAL_DOCS[key];
          return (
            <Link key={key} href={`/terms/${key}`} className={styles.row}>
              <div className={styles.rowMain}>
                <span className={styles.rowName}>{doc.title}</span>
                <span className={styles.rowSub}>{doc.summary}</span>
              </div>
              <span className={styles.rowSub}>{doc.version}</span>
            </Link>
          );
        })}
      </div>
    </main>
  );
}
