import { Suspense } from "react";
import { AppHeader } from "../../AppHeader";
import marketStyles from "../../market.module.css";
import { PinSetup } from "./PinSetup";

export const dynamic = "force-dynamic";

// 간편 비밀번호 설정 — 가입 직후 풀 로그인 화면에서 이리로 보내진다.
// 설정 관문(최근성 — 방금 본인 인증한 세션만)은 API 쪽이 지킨다.

export default function PinSetupPage() {
  return (
    <>
      <AppHeader title="간편 로그인 설정" backHref="/settings" />
      <main className={marketStyles.page}>
        <Suspense>
          <PinSetup />
        </Suspense>
      </main>
    </>
  );
}
