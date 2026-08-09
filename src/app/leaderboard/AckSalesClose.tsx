"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "./leaderboard.module.css";

// 판매 마감된 내 카드 래퍼 — 카드(OwnedCard) 위에 마감 사실을, 아래에 확인 버튼을 붙인다.
//
// 마감된 카드는 구매자에게만 계속 보인다: 남들에게는 "지금 살 수 있는 카드"가 아니지만
// 구매자에게는 아직 결과를 기다리는 내 물건이다. 확인을 누르면 리더보드에서 내려가고
// (봤다는 표시일 뿐 지워지는 게 아니다) MY 구매 내역에는 계속 남는다.

export function AckSalesClose({
  reportId,
  children,
}: {
  reportId: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function ack() {
    setBusy(true);
    try {
      await fetch("/api/purchases/ack-sales-close", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.ackWrap}>
      <p className={styles.ackNote}>
        판매가 마감된 카드예요. 카드는 그대로 검증되어 시한에 자동 판정됩니다.
      </p>
      {children}
      <button type="button" className={styles.ackBtn} onClick={ack} disabled={busy}>
        {busy ? "정리 중…" : "확인했어요 — 목록에서 내리기 (MY 구매 내역에는 남아요)"}
      </button>
    </div>
  );
}
