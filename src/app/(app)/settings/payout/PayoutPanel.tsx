"use client";

import { useState } from "react";
import type { PayoutAccountView } from "@/server/payoutAccountView";
import { AccountForm } from "./AccountForm";
import { CooldownConfirm } from "./CooldownConfirm";
import { FreezeButton } from "./FreezeButton";
import styles from "./payout.module.css";

// 계좌 상태 · 등록 · 동결을 **한 상태로 묶는다.**
//
// 셋이 같은 값을 보기 때문이다: 계좌를 등록하면 상태 카드의 뒤 4자리와 유예 시간이
// 즉시 바뀌어야 하고, 동결하면 등록 버튼이 의미를 잃는다. 각자 새로고침하게 두면
// 화면 안에서 서로 다른 시점의 사실이 동시에 보인다.

const STATUS_LABEL: Record<string, string> = {
  VERIFIED: "검증 완료",
  UNVERIFIED: "검증 대기 (예금주 조회 전)",
  HOLDER_MISMATCH: "예금주 불일치 — 확인 필요",
};

export function PayoutPanel({ initial }: { initial: PayoutAccountView }) {
  const [view, setView] = useState(initial);

  return (
    <>
      <div className={styles.status}>
        {view.registered ? (
          <>
            <div className={styles.statusLine}>
              <span className={styles.statusKey}>계좌</span>
              <span className={styles.statusValue}>
                {view.bankCode} ···{view.last4}
              </span>
            </div>
            <div className={styles.statusLine}>
              <span className={styles.statusKey}>상태</span>
              <span className={styles.statusValue}>
                {STATUS_LABEL[view.status ?? ""] ?? view.status}
              </span>
            </div>
            {view.cooldownHoursLeft != null && (
              <div className={styles.statusLine}>
                <span className={styles.statusKey}>지급 유예</span>
                <span className={styles.statusValue}>{view.cooldownHoursLeft}시간 남음</span>
              </div>
            )}
            {/* 유예 즉시 해제 — 번호는 낯선 기기(이 변경을 만든 기기)에 보이고,
                입력은 평소 기기에서만 받는다. 두 갈래가 한 컴포넌트에 있다 */}
            {(view.cooldownCode != null || view.canConfirmCooldown) && (
              <CooldownConfirm view={view} onDone={setView} />
            )}
          </>
        ) : (
          <div className={styles.statusLine}>
            <span className={styles.statusKey}>계좌</span>
            <span className={styles.statusValue}>등록되지 않음</span>
          </div>
        )}
      </div>

      <div style={{ padding: "4px 16px 8px" }}>
        {/* 동결 중에는 등록 버튼을 감춘다 — 동결은 "지금은 아무것도 하지 말자"는
            상태인데 그 옆에 계좌를 바꾸는 버튼이 있으면 말이 어긋난다 */}
        {!view.frozen && <AccountForm view={view} onDone={setView} />}
      </div>

      <div className={styles.sectionGap}>
        <FreezeButton initial={view} />
      </div>
    </>
  );
}
