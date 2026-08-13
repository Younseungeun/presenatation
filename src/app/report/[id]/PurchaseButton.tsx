"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { REFUND_POLICY_SUMMARY } from "@/domain/legalDocs";
import styles from "../../market.module.css";

/**
 * 구매 버튼. 로그인(본인 인증)이 없으면 /login으로 유도한다.
 * 구매는 에스크로 보관 — 판정 후 적중이면 리서처 정산, 실패면 현금 환불.
 * 구매 전 환불 규정을 고지하고 동의를 받는다 (전자상거래법).
 */
export function PurchaseButton({
  reportId,
  priceKrw,
  hasIdentity,
}: {
  reportId: string;
  priceKrw: number;
  hasIdentity: boolean;
}) {
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cartBusy, setCartBusy] = useState(false);
  const [added, setAdded] = useState(false);

  // 카드지갑 담기는 결제가 아니므로 환불 규정 동의를 받지 않는다(동의는 결제 시점에 받는다)
  async function addToCart() {
    if (!hasIdentity) {
      router.push(`/login?next=/report/${reportId}`);
      return;
    }
    setCartBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "카드지갑 담기 실패");
        return;
      }
      setAdded(true);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCartBusy(false);
    }
  }

  async function purchase() {
    if (!hasIdentity) {
      router.push(`/login?next=/report/${reportId}`);
      return;
    }
    if (!agreed) {
      setError("환불 규정에 동의해야 결제할 수 있습니다.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreedRefund: true }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "구매 실패");
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {hasIdentity && (
        <>
          <p className={styles.refundNotice}>{REFUND_POLICY_SUMMARY}</p>
          {/* 결제 수단 선택이 없다 — 카드(간편결제 포함)만 받는다.
              무통장입금은 계좌를 받는 시각과 입금하는 시각이 달라, 그 사이 시세가 움직이면
              "결제가 승인되는 순간 광고 폭의 절반 이상"이라는 이 화면의 고지가 깨진다
              (server/purchaseService.ACCEPTED_PAYMENT_METHODS) */}
          <label className={styles.consent}>
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span>
              위 환불 규정과{" "}
              <Link href="/terms/TERMS_OF_SERVICE" target="_blank">
                이용약관
              </Link>
              을 확인했습니다 (필수)
            </span>
          </label>
        </>
      )}
      <button
        className={styles.primaryBtn}
        onClick={purchase}
        disabled={busy || (hasIdentity && !agreed)}
      >
        {busy
          ? "결제 중…"
          : hasIdentity
            ? `${priceKrw.toLocaleString()}원 결제하고 열람`
            : "본인 인증하고 구매하기"}
      </button>
      <button
        type="button"
        className={styles.secondaryBtn}
        onClick={addToCart}
        disabled={cartBusy || added}
      >
        {added ? "카드지갑에 담김" : cartBusy ? "담는 중…" : "카드지갑에 담기"}
      </button>
      {error && <p className={styles.err}>{error}</p>}
    </div>
  );
}
