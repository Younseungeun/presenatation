"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../../market.module.css";

/**
 * 구매 버튼. 데모 신원이 없으면 먼저 "데모 구매자로 시작"으로 쿠키를 설정한 뒤 구매한다.
 * 구매는 에스크로 보관 — 판정 후 적중이면 리서처 정산, 실패면 현금 환불.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function ensureIdentity(): Promise<void> {
    if (hasIdentity) return;
    await fetch("/api/dev/act-as-buyer", { method: "POST" });
  }

  async function purchase() {
    setBusy(true);
    setError(null);
    try {
      await ensureIdentity();
      const res = await fetch(`/api/reports/${reportId}/purchase`, { method: "POST" });
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
      <button className={styles.primaryBtn} onClick={purchase} disabled={busy}>
        {busy ? "결제 중…" : `${priceKrw.toLocaleString()}원 결제하고 열람`}
      </button>
      {!hasIdentity && (
        <p className={styles.sub} style={{ marginTop: 8 }}>
          결제 시 데모 구매자로 자동 로그인됩니다 (PG 연동 전 스텁).
        </p>
      )}
      {error && <p className={styles.err}>{error}</p>}
    </div>
  );
}
