"use client";

import { useEffect, useState } from "react";
import market from "../../market.module.css";
import styles from "./notifications.module.css";

// 알림 켜기 — **브라우저의 허락을 받고, 그 기기의 주소를 서버에 등록한다.**
//
// 세 가지가 다 맞아야 알림이 온다: ① 브라우저가 지원 ② 사용자가 허락 ③ 서버에 등록.
// 하나만 어긋나도 조용히 안 오므로 **어디서 막혔는지를 화면이 말해야 한다** —
// "알림이 안 와요"라는 문의의 대부분이 여기서 갈린다.

type State = "확인중" | "미지원" | "차단됨" | "꺼짐" | "켜짐" | "처리중";

/**
 * base64url 공개키 → 브라우저가 요구하는 바이트 배열.
 *
 * ArrayBuffer를 먼저 만들고 그 위에 뷰를 얹는다 — `Uint8Array.from`이 돌려주는 타입은
 * SharedArrayBuffer일 수도 있어서 `applicationServerKey`가 받지 않는다(타입 검사가 잡아냈다).
 */
function urlB64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function PushToggle({ vapidPublicKey }: { vapidPublicKey: string }) {
  const [state, setState] = useState<State>("확인중");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("미지원");
      return;
    }
    if (Notification.permission === "denied") {
      setState("차단됨");
      return;
    }
    navigator.serviceWorker
      .getRegistration("/push-sw.js")
      .then((reg) => reg?.pushManager.getSubscription())
      .then((sub) => setState(sub ? "켜짐" : "꺼짐"))
      .catch(() => setState("꺼짐"));
  }, []);

  const enable = async () => {
    setState("처리중");
    setError(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "차단됨" : "꺼짐");
        return;
      }
      const reg = await navigator.serviceWorker.register("/push-sw.js");
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true, // 숨은 푸시 금지 — 받으면 반드시 알림을 띄운다
        applicationServerKey: urlB64ToUint8Array(vapidPublicKey),
      });
      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "web",
          token: JSON.stringify(sub),
          label: navigator.userAgent.slice(0, 60),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "등록에 실패했습니다");
      setState("켜짐");
    } catch (e) {
      setError(e instanceof Error ? e.message : "알림을 켜지 못했습니다");
      setState("꺼짐");
    }
  };

  const disable = async () => {
    setState("처리중");
    try {
      const reg = await navigator.serviceWorker.getRegistration("/push-sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: JSON.stringify(sub) }),
        });
        await sub.unsubscribe();
      }
      setState("꺼짐");
    } catch {
      setState("켜짐");
    }
  };

  if (state === "미지원") {
    return (
      <p className={styles.notice}>
        이 브라우저는 알림을 지원하지 않습니다. 아이폰이라면 <strong>공유 → 홈 화면에 추가</strong>를
        먼저 하셔야 알림을 받을 수 있어요.
      </p>
    );
  }
  if (state === "차단됨") {
    return (
      <p className={styles.notice}>
        이 브라우저에서 <strong>알림을 차단</strong>해 두셨습니다. 주소창 옆 자물쇠 아이콘 →
        알림 → 허용으로 바꾸신 뒤 이 화면을 새로고침해 주세요.
      </p>
    );
  }

  return (
    <div>
      <p className={styles.notice}>
        {state === "켜짐" ? (
          <>
            이 기기로 알림이 갑니다. <strong>잠금화면에는 무슨 일이 있었는지까지만</strong> 뜨고
            금액·종목은 앱을 열어야 보입니다 — 알림은 옆 사람도 볼 수 있으니까요.
          </>
        ) : (
          <>
            판정 결과·환불·정산, 그리고 <strong>계좌가 바뀌었을 때</strong> 알려드립니다.
            특히 마지막은 본인이 아닐 때 손쓸 수 있는 유일한 시간이라 켜 두시길 권합니다.
          </>
        )}
      </p>
      {error && <p className={styles.notice}>⚠ {error}</p>}
      <button
        type="button"
        className={market.primaryBtn}
        onClick={state === "켜짐" ? disable : enable}
        disabled={state === "처리중" || state === "확인중"}
      >
        {state === "처리중"
          ? "처리 중…"
          : state === "켜짐"
            ? "이 기기 알림 끄기"
            : "이 기기 알림 켜기"}
      </button>
    </div>
  );
}
