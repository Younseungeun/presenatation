import { Suspense } from "react";
import { AppHeader } from "../AppHeader";
import { LoginForm } from "./LoginForm";
import styles from "../researcher/researcher.module.css";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <>
      <AppHeader title="로그인" backHref="/my" />
      <main className={styles.page} style={{ maxWidth: 460 }}>
        <p className={styles.sub}>
          휴대폰 본인 인증으로 시작합니다. 필명으로 활동하더라도 계정은 실명 기준 1인
          1개로 유지됩니다.
        </p>
        <Suspense>
          <LoginForm />
        </Suspense>
      </main>
    </>
  );
}
