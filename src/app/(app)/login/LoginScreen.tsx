"use client";

import { Suspense, useSyncExternalStore } from "react";
import { SimpleLogin } from "./SimpleLogin";
import { LoginForm } from "./LoginForm";
import styles from "../researcher/researcher.module.css";

// 로그인 화면 (2026-08-29 사용자 확정):
//   · 등록 기기 → **간편 로그인(방식 선택)이 곧 화면.** '다른 방식으로 로그인'은 뺐다.
//     생체는 이 화면 위에서 기기 OS 가 바로 처리한다(SimpleLogin 주석).
//   · 새 기기(간편 로그인 미설정) → 본인 인증(휴대폰)이 유일한 길이라 바로 보여준다.

const NO_SUBSCRIBE = () => () => {};
const useHasDevice = () =>
  useSyncExternalStore(
    NO_SUBSCRIBE,
    () => document.cookie.split("; ").some((c) => c.startsWith("rm_device_hint=")),
    () => false,
  );
// full=1 → 등록 기기여도 본인 인증 폼을 띄운다 (비상 복구 경로).
// reset=1 → 간편 비밀번호 재설정용 본인 인증(가입 UI 없이 휴대폰 인증만).
const useLoginParam = (key: string) =>
  useSyncExternalStore(
    NO_SUBSCRIBE,
    () => new URLSearchParams(window.location.search).get(key) === "1",
    () => false,
  );
// **개발 전용 ?demo=picker|pin** — 기기 쿠키가 없어도 간편 로그인 화면을 미리 본다.
// (운영 빌드에선 무시. SimpleLogin 도 같은 규칙으로 데모를 자기 안에서 처리한다.)
const useDemoParam = () =>
  useSyncExternalStore(
    NO_SUBSCRIBE,
    () =>
      process.env.NODE_ENV !== "production" &&
      ["picker", "pin", "bio"].includes(
        new URLSearchParams(window.location.search).get("demo") ?? "",
      ),
    () => false,
  );

export function LoginScreen() {
  const hasDevice = useHasDevice();
  const forceFull = useLoginParam("full");
  const isReset = useLoginParam("reset");
  const isDemo = useDemoParam();
  // 새 기기(간편 로그인 미설정)이거나, 등록 기기에서 복구(full=1/reset=1)를 택했을 때 본인 인증.
  // 단 데모 미리보기(?demo=)면 항상 간편 로그인 화면을 보여준다.
  const showFull = !isDemo && (!hasDevice || forceFull || isReset);

  return (
    <>
      {/* 등록 기기 + 복구 아님 → 방식 선택(간편 로그인). 그 외엔 self-gate 로 null (데모 제외) */}
      {!showFull && <SimpleLogin />}

      {showFull && (
        <>
          <p className={styles.sub}>
            {isReset
              ? "휴대폰 본인 인증 후 간편 비밀번호를 다시 설정할 수 있어요. 같은 번호는 항상 같은 계정으로 연결됩니다."
              : "휴대폰 본인 인증으로 시작합니다. 필명으로 활동하더라도 계정은 실명 기준 1인 1개로 유지됩니다."}
          </p>
          <Suspense>
            <LoginForm mode={isReset ? "reset" : "signup"} />
          </Suspense>
        </>
      )}
    </>
  );
}
