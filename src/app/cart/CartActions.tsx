"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../market.module.css";

export function RemoveButton({ reportId }: { reportId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function remove(e: React.MouseEvent) {
    // 이 버튼은 카드 전체를 감싼 리포트 링크 **안**에 있다 — 막지 않으면
    // 빼기 한 번에 삭제와 리포트 상세 이동이 같이 일어난다
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    await fetch("/api/cart", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportId }),
    });
    router.refresh();
    setBusy(false);
  }

  return (
    <button type="button" className={styles.cartRemove} onClick={remove} disabled={busy}>
      {busy ? "빼는 중…" : "빼기"}
    </button>
  );
}

export function CheckoutButton({
  payableCount,
  payableKrw,
}: {
  payableCount: number;
  payableKrw: number;
}) {
  const router = useRouter();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ reportId: string; reason: string }[]>([]);

  async function checkout() {
    setBusy(true);
    setError(null);
    setFailed([]);
    try {
      const res = await fetch("/api/cart/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreedRefund: true }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "결제 실패");
        return;
      }
      if (body.failed?.length) setFailed(body.failed);
      router.refresh();
      if (!body.failed?.length) router.push("/my?tab=active");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.cartCheckout}>
      {/* 결제 수단 선택 없음 — 카드만 받는다 (server/purchaseService.ACCEPTED_PAYMENT_METHODS) */}
      <label className={styles.consent}>
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
        <span>
          예측이 적중하지 못하면 콘텐츠 거래대금을 현금으로 환불합니다(환불 대상은 투자 손실이
          아닌 콘텐츠 대금). 위 환불 규정과{" "}
          <Link href="/terms/TERMS_OF_SERVICE" target="_blank">
            이용약관
          </Link>
          을 확인했습니다 (필수)
        </span>
      </label>
      <button
        type="button"
        className={styles.primaryBtn}
        onClick={checkout}
        disabled={!agreed || busy || payableCount === 0}
      >
        {busy
          ? "결제 중…"
          : `${payableCount}건 · ${payableKrw.toLocaleString()}원 결제하기`}
      </button>
      {error && <p className={styles.err}>{error}</p>}
      {failed.length > 0 && (
        <p className={styles.err}>
          {failed.length}건은 구매하지 못했습니다: {failed.map((f) => f.reason).join(" / ")}
        </p>
      )}
    </div>
  );
}
