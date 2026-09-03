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
import { RejectAppealForm } from "./new/RejectAppealForm";

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
  // 게시 전 되묻기 — 서버가 "보류감"이라 판단하면 게시 대신 이 정보를 돌려준다.
  const [hold, setHold] = useState<{
    decision: string;
    categories: string[];
    repeated: boolean;
  } | null>(null);

  async function act(action: "publish" | "withdraw" | "close-sales", acknowledgeHold = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/${reportId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "publish" ? { acknowledgeHold } : {}),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.issues ? body.issues.join(" / ") : body.error ?? "실패");
        return;
      }
      // 보류감이면 게시하지 않고 팝업을 띄운다 (BLOCK 처럼 강제하지 않는다).
      if (body?.needsHoldConfirm) {
        setHold({
          decision: String(body.decision ?? ""),
          categories: Array.isArray(body.categories) ? body.categories.map(String) : [],
          repeated: body.repeated === true,
        });
        return;
      }
      setHold(null);
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
      {/* 즉시 거절(규칙 BLOCK)이면 그 자리에서 이의를 낼 수 있다 (B1) — 거절 문구는 "[위반 · 유형]"으로
          시작한다(findingMessages). 보류·저장 실패 같은 다른 오류에는 안 뜬다 */}
      {error && error.startsWith("[위반") && <RejectAppealForm reportId={reportId} />}

      {hold && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setHold(null)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20,
            zIndex: 100,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "var(--surface, #fff)",
              borderRadius: 16,
              padding: "22px 20px",
              maxWidth: 360,
              width: "100%",
              boxShadow: "0 12px 40px rgba(0,0,0,0.2)",
            }}
          >
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>
              게시 전에 확인해주세요
            </div>
            <p style={{ fontSize: 13.5, lineHeight: 1.7, color: "var(--text)", margin: "0 0 10px" }}>
              자동 검수 결과, 이 리포트는 게시 직후 바로 판매되지 않고{" "}
              <b>운영자 검토(보류)</b>로 넘어갈 가능성이 높습니다.
            </p>
            {hold.categories.length > 0 && (
              <p style={{ fontSize: 13, lineHeight: 1.7, color: "var(--text-dim)", margin: "0 0 8px" }}>
                확인이 필요한 유형: <b>{hold.categories.join(", ")}</b>
              </p>
            )}
            {hold.repeated && (
              <p style={{ fontSize: 13, lineHeight: 1.7, color: "var(--text-dim)", margin: "0 0 8px" }}>
                반려가 여러 번 누적돼 자동 게시 대상이 아닙니다.
              </p>
            )}
            <p style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text-faint)", margin: "6px 0 16px" }}>
              그대로 게시하면 검토 후 승인 시 판매가 시작되고, 반려되면 사유와 함께 초안으로
              돌아옵니다. 지금 본문을 고치면 검토 없이 바로 게시될 수 있어요.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className={styles.actionBtn}
                style={{ flex: 1, background: "var(--surface-2, #f2f4f6)", color: "var(--text)" }}
                onClick={() => setHold(null)}
              >
                고쳐 쓰기
              </button>
              <button
                type="button"
                className={styles.actionBtn}
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => act("publish", true)}
              >
                그래도 게시
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
