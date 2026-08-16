"use client";

import { useState, useSyncExternalStore } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import styles from "./passkey.module.css";

// 브라우저가 패스키를 지원하는지 — **서버에서는 항상 false로 그린다.**
//
// useEffect로 setState하면 첫 렌더에 버튼이 없다가 번쩍 나타난다. useSyncExternalStore는
// 서버 스냅샷을 따로 주게 되어 있어 하이드레이션이 어긋나지 않는다.
// 값이 바뀔 일이 없으므로 구독은 빈 함수다.
const NO_SUBSCRIBE = () => () => {};
const usePasskeySupported = () =>
  useSyncExternalStore(
    NO_SUBSCRIBE,
    () => !!window.PublicKeyCredential,
    () => false,
  );

// 생체 로그인 버튼 — 평소 로그인은 여기서 끝난다.
//
// **본인 인증 위에 둔다.** 아래 두면 매번 쓰는 길이 아래에 있고, 1년에 한 번 쓰는
// 길(새 기기)이 위에 있게 된다. 화면의 순서는 곧 "무엇이 기본인가"의 선언이다.
//
// 기기가 패스키를 지원하지 않으면 **아무것도 그리지 않는다.** 눌러도 안 되는 버튼을
// 보여 주면 "이 서비스가 고장났나"로 읽힌다 — 그 경우 본인 인증만 보이는 것이 맞다.

export function PasskeyButton() {
  const supported = usePasskeySupported();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!supported) return null;

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch("/api/passkey/login");
      if (!optionsRes.ok) throw new Error("지금은 생체 로그인을 쓸 수 없습니다");
      const response = await startAuthentication({ optionsJSON: await optionsRes.json() });

      const verifyRes = await fetch("/api/passkey/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      if (!verifyRes.ok) {
        // 사유를 나누지 않는다 — "등록 안 된 기기"와 "서명 오류"의 차이만으로도
        // 어떤 자격증명이 이 서비스에 있는지 훑을 수 있다
        throw new Error("이 기기로는 로그인할 수 없습니다. 아래에서 본인 인증으로 진행해주세요.");
      }
      // 세션 쿠키가 방금 생겼다 — 전체 페이지 로드로 서버가 그것을 읽게 한다
      window.location.href = "/";
    } catch (e) {
      // 사용자가 지문 창을 그냥 닫은 것은 오류가 아니다. 조용히 되돌린다
      const name = (e as { name?: string })?.name;
      if (name === "NotAllowedError" || name === "AbortError") {
        setBusy(false);
        return;
      }
      setError(e instanceof Error ? e.message : "로그인에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <button type="button" className={styles.button} onClick={signIn} disabled={busy}>
        {busy ? "확인하는 중…" : "지문·얼굴로 로그인"}
      </button>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
