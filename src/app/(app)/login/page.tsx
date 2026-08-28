// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import { Suspense } from "react";
import { AppHeader } from "../AppHeader";
import { LoginForm } from "./LoginForm";
import { SimpleLogin } from "./SimpleLogin";
import pkStyles from "./passkey.module.css";
import styles from "../researcher/researcher.module.css";

export const dynamic = "force-dynamic";

// 로그인 화면은 **두 길**이다. 순서가 곧 "무엇이 기본인가"의 선언이라 위아래를 이렇게 둔다:
//   위  생체 로그인   — 평소 쓰는 길 (등록된 기기가 있으면 이걸로 끝난다)
//   아래 본인 인증     — 처음이거나 새 기기일 때만
// 뒤집으면 매일 쓰는 길이 아래에, 1년에 한 번 쓰는 길이 위에 놓인다.
export default function LoginPage() {
  return (
    <>
      <AppHeader title="로그인" backHref="/my" />
      <main className={styles.page} style={{ maxWidth: 460 }}>
        {/* 순서가 곧 우선순위다 (2026-08-16 사용자 확정, 2026-08-28 흐름화):
            생체 먼저 → 3회 실패 시 방법 선택 → 간편 비밀번호 → 본인 인증(처음·새 기기).
            SimpleLogin 이 앞 셋을 상태로 몰고, 본인 인증(LoginForm)은 '다른 방식'의 도착지다 */}
        <SimpleLogin />
        <div id="fullauth" className={pkStyles.divider}>
          <span>처음이거나 새 기기라면</span>
        </div>
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
