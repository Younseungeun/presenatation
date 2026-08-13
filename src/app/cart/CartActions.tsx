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
  const [failed, setFailed] = useState<
    { reportId: string; reason: string; blocking: boolean }[]
  >([]);

  /** 실제로 결제를 막은 건들 — 남의 사정으로 함께 접힌 건과 구분한다 */
  const blocking = failed.filter((f) => f.blocking);

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

  /** 막은 건들을 카드지갑에서 빼고 나머지로 다시 결제한다 */
  async function dropBlockedAndRetry() {
    setBusy(true);
    setError(null);
    try {
      for (const f of blocking) {
        await fetch("/api/cart", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reportId: f.reportId }),
        });
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }
    setBusy(false);
    await checkout();
  }

  return (
    <div className={styles.cartCheckout}>
      {/* 결제 수단 선택 없음 — 즉시 승인되고 부분 취소가 되는 수단만 받는다
          (server/purchaseService.ACCEPTED_PAYMENT_METHODS) */}
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
        // 일괄 결제는 전부 사거나 아무것도 사지 않는다 — 한 건이 막으면 전체가 접힌다.
        // "결제된 금액이 없습니다"를 먼저 말한다: 부분 성공을 의심하게 두면 안 된다.
        //
        // 그리고 **막힌 것만 빼고 다시 결제하는 길**을 그 자리에서 준다. 많이 담은
        // 사람일수록 하나쯤 시세가 흔들려 전체가 막히는데, 어느 것을 빼야 하는지
        // 직접 찾게 두면 담을수록 결제가 어려워지는 역설이 그대로 남는다
        <div>
          <p className={styles.err}>
            결제가 진행되지 않았습니다 (결제된 금액 없음). 막은 사유:{" "}
            {[...new Set(failed.filter((f) => f.blocking).map((f) => f.reason))].join(" / ")}
          </p>
          {blocking.length > 0 && blocking.length < failed.length && (
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={dropBlockedAndRetry}
              disabled={busy}
            >
              {busy ? "다시 결제 중…" : `막힌 ${blocking.length}건 빼고 다시 결제하기`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
