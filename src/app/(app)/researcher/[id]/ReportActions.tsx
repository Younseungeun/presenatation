"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import styles from "../researcher.module.css";

// 게시·철회·판매 마감은 API를 호출한다 (인증은 세션, 소유권은 서버가 검증).
//
// **철회와 판매 마감은 다른 일이다** — 둘을 나란히 두는 만큼 구별이 분명해야 한다:
//   · 철회      → 카드를 무효로. 기존 구매자에게 **전액 환불**, 점수 0. 사실상 없던 일
//   · 판매 마감 → **판매만** 중단. 카드는 살아서 시한에 판정되고 환불 조건도 그대로
// 촉매가 지나 논지가 소비됐을 때 필요한 것은 후자다. 앞의 것을 누르면 판정 기회가
// 사라지므로, 버튼 색과 확인 문구로 둘의 무게 차이를 드러낸다.
export function ReportActions({
  reportId,
  status,
  salesClosed = false,
  canCloseSales = false,
}: {
  reportId: string;
  status: string;
  /** 이미 판매가 마감됐나 (사유 무관) */
  salesClosed?: boolean;
  /**
   * 지금 자발 마감을 할 수 있나 — 판매 중이고 시간 규칙으로도 아직 열려 있을 때만.
   * 서버가 계산해 넘긴다: 렌더 중 Date.now()를 부르면 순수성 규칙에 걸린다
   */
  canCloseSales?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "publish" | "withdraw" | "close-sales") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/${action}`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body.issues ? body.issues.join(" / ") : body.error ?? "실패");
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // 되돌릴 수 없는 행위는 한 번 묻는다. 확인 문구에 **무엇이 남는지**를 함께 적는 이유:
  // "판매 마감"만 보면 카드까지 죽는 줄 알고 못 누르거나, 반대로 가볍게 누른다
  function confirmCloseSales() {
    if (
      window.confirm(
        "이 리포트의 판매를 지금 마감할까요?\n\n" +
          "· 다시 열 수 없습니다\n" +
          "· 카드는 그대로 검증되어 시한에 판정됩니다\n" +
          "· 기존 구매자의 환불 조건은 변하지 않습니다",
      )
    ) {
      void act("close-sales");
    }
  }

  return (
    <div className={styles.actions}>
      {status === "DRAFT" && (
        <button className={styles.actionBtn} disabled={busy} onClick={() => act("publish")}>
          게시하기
        </button>
      )}
      {status === "PENDING_REVIEW" && (
        <span className={styles.hint}>
          자동 검수에서 확인이 필요한 표현이 있어 운영자 검토 중입니다. 승인되면 판매가
          시작됩니다.
        </span>
      )}
      {status === "PUBLISHED" && canCloseSales && (
        <button className={styles.actionBtn} disabled={busy} onClick={confirmCloseSales}>
          판매 마감
        </button>
      )}
      {status === "PUBLISHED" && salesClosed && (
        <span className={styles.hint}>판매 마감됨 · 카드는 시한에 판정됩니다</span>
      )}
      {status === "PUBLISHED" && (
        <button
          className={`${styles.actionBtn} ${styles.danger}`}
          disabled={busy}
          onClick={() => act("withdraw")}
        >
          철회
        </button>
      )}
      {error && <span className={styles.hint} style={{ color: "#c62828" }}>{error}</span>}
    </div>
  );
}
