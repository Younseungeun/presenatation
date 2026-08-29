// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import { AppHeader } from "../AppHeader";
import { LoginScreen } from "./LoginScreen";
import styles from "../researcher/researcher.module.css";

export const dynamic = "force-dynamic";

// 로그인 화면 — **깨끗한 간편 로그인이 주인공** (2026-08-29 사용자 확정).
// 등록 기기면 생체/간편 비밀번호만 앞에 두고, 본인 인증은 '다른 방식' 뒤로 접는다.
// 상태(어느 방식을 폈나)는 클라이언트라 LoginScreen 이 몰고, 페이지는 껍데기만.
export default function LoginPage() {
  return (
    <>
      <AppHeader backHref="/my" seamless />
      <main className={styles.page} style={{ maxWidth: 460 }}>
        <LoginScreen />
      </main>
    </>
  );
}
