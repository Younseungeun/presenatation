import { Suspense } from "react";
import { LoginForm } from "./LoginForm";
import styles from "../researcher/researcher.module.css";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <main className={styles.page} style={{ maxWidth: 460 }}>
      <h1 style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em" }}>본인 인증</h1>
      <p className={styles.sub}>
        휴대폰 본인 인증으로 시작합니다. 필명으로 활동하더라도 계정은 실명 기준 1인
        1개로 유지됩니다.
      </p>
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
