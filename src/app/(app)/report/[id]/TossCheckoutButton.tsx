"use client";

import Script from "next/script";
import { useCallback, useRef, useState } from "react";
import styles from "../../market.module.css";

// 토스페이먼츠 결제위젯 테스트 연동 — 실제 SDK로 실제 승인 API를 타되,
// "문서용 테스트 키"라 카드가 실제로 승인되거나 금액이 빠지는 일은 없다.
// 흐름: 결제 의도 생성(/api/payments/intent) → 위젯 렌더 → 결제창 → successUrl →
// 승인 확정(/api/payments/confirm) → purchaseReport
//
// 전역 TossPayments 함수는 next/script로 로드한 SDK가 window에 붙인다.
declare global {
  interface Window {
    TossPayments?: (clientKey: string) => TossPaymentsSDK;
  }
}
interface TossWidgets {
  setAmount(amount: { currency: string; value: number }): Promise<void>;
  renderPaymentMethods(opts: { selector: string }): Promise<void>;
  renderAgreement(opts: { selector: string }): Promise<void>;
  requestPayment(req: {
    orderId: string;
    orderName: string;
    successUrl: string;
    failUrl: string;
    customerEmail?: string;
    customerName?: string;
  }): Promise<void>;
}
interface TossPaymentsSDK {
  widgets(opts: { customerKey: string }): TossWidgets;
}

export function TossCheckoutButton({
  reportId,
  clientKey,
  buyerId,
}: {
  reportId: string;
  clientKey: string;
  buyerId: string;
}) {
  const [sdkReady, setSdkReady] = useState(false);
  // idle: 시작 전 / preparing: 위젯 영역을 마운트하고 렌더 준비 중 / ready: 결제 요청 가능 / requesting: 결제창 여는 중
  const [phase, setPhase] = useState<"idle" | "preparing" | "ready" | "requesting">("idle");
  const [error, setError] = useState<string | null>(null);
  const [widgets, setWidgets] = useState<TossWidgets | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [orderName, setOrderName] = useState<string | null>(null);
  // 인라인 ref 콜백은 리렌더마다 새 함수가 되어 React가 재호출할 수 있다 —
  // state(widgets)는 그 재호출 사이에 아직 반영 전일 수 있어 이중 실행을 막기엔 부족하다.
  // 렌더와 무관하게 살아있는 ref로 "이미 시작했다"를 확정적으로 막는다.
  const startedRef = useRef(false);

  async function start() {
    if (!window.TossPayments) {
      setError("결제 SDK를 아직 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
      return;
    }
    setError(null);
    // 위젯이 렌더될 영역(#toss-payment-method 등)을 먼저 DOM에 붙인다 —
    // renderPaymentMethods()는 이미 존재하는 selector에만 그릴 수 있다.
    setPhase("preparing");
  }

  // 위젯 영역 div가 실제로 DOM에 붙은 뒤(= phase가 preparing으로 바뀐 뒤) 렌더를 진행한다.
  // useEffect 없이 ref 콜백으로 처리 — 컨테이너가 마운트되는 시점을 그대로 트리거로 쓴다.
  // ref 콜백은 동기 반환값(void)만 허용해 async 함수를 직접 넣을 수 없다 — 동기 래퍼로 감싼다.
  const onMounted = useCallback(
    (container: HTMLDivElement | null) => {
      if (!container || startedRef.current) return;
      startedRef.current = true;

      async function setupWidgets() {
        try {
          const res = await fetch("/api/payments/intent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reportId }),
          });
          const body = await res.json();
          if (!res.ok) {
            setError(body.error ?? "결제 준비 실패");
            setPhase("idle");
            return;
          }

          const tossPayments = window.TossPayments!(clientKey);
          const w = tossPayments.widgets({ customerKey: buyerId });
          await w.setAmount({ currency: "KRW", value: body.amountKrw });
          await w.renderPaymentMethods({ selector: "#toss-payment-method" });
          await w.renderAgreement({ selector: "#toss-agreement" });

          setWidgets(w);
          setOrderId(body.orderId);
          setOrderName(body.orderName);
          setPhase("ready");
        } catch (e) {
          setError((e as Error).message);
          setPhase("idle");
          startedRef.current = false; // 실패했으니 다시 시도할 수 있게 되돌린다
        }
      }

      void setupWidgets();
    },
    [reportId, clientKey, buyerId],
  );

  async function pay() {
    if (!widgets || !orderId || !orderName) return;
    setPhase("requesting");
    setError(null);
    try {
      await widgets.requestPayment({
        orderId,
        orderName,
        successUrl: `${window.location.origin}/payments/toss/success`,
        failUrl: `${window.location.origin}/payments/toss/fail`,
      });
      // 성공하면 브라우저가 successUrl로 이동한다 — 여기 이후 코드는 보통 실행되지 않는다
    } catch (e) {
      setError((e as Error).message);
      setPhase("ready");
    }
  }

  return (
    <div style={{ marginTop: 10 }}>
      <Script src="https://js.tosspayments.com/v2/standard" onLoad={() => setSdkReady(true)} />

      {phase === "idle" && (
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={start}
          disabled={!sdkReady}
        >
          {sdkReady ? "토스페이먼츠로 테스트 결제해보기" : "결제 SDK 불러오는 중…"}
        </button>
      )}

      {phase !== "idle" && (
        <div>
          <div id="toss-payment-method" ref={onMounted} />
          <div id="toss-agreement" />
          {phase === "preparing" && <p className={styles.sub}>결제 UI 준비 중…</p>}
          {(phase === "ready" || phase === "requesting") && (
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={pay}
              disabled={phase === "requesting"}
              style={{ marginTop: 12 }}
            >
              {phase === "requesting" ? "결제창 여는 중…" : "테스트 결제 진행하기"}
            </button>
          )}
          <p className={styles.sub} style={{ marginTop: 8, fontSize: 12 }}>
            토스페이먼츠 샌드박스 연동입니다. 실제 카드가 승인되거나 금액이 빠지지 않습니다.
          </p>
        </div>
      )}

      {error && <p className={styles.err}>{error}</p>}
    </div>
  );
}
