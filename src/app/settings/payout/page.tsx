import Link from "next/link";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { payoutAccountView } from "@/server/payoutAccountView";
import { AppHeader } from "../../AppHeader";
import marketStyles from "../../market.module.css";
import styles from "./payout.module.css";
import { FreezeButton } from "./FreezeButton";

export const dynamic = "force-dynamic";

// 정산 계좌 보호 — **동결 버튼의 집.**
//
// 42차 검토: "보안은 기능이 아니라 UX에서 완성된다." 41차에 만든 동결 장치는
// 서비스 함수로만 존재해서, 리서처가 계좌 변경 알림을 받아도 누를 곳이 없었다.
//
// 그리고 이 장치는 **숨기지 않는다.** 탈취자가 알아도 해가 없기 때문이다 —
// 해커의 목적은 돈을 빼는 것인데, 동결은 돈을 막고 운영자를 부른다. 해커에게는
// 누를 이유가 없고, 푸는 권한은 운영자에게만 있어 눌러도 얻을 것이 없다.
// 그래서 안내는 크게 적는 편이 낫다 — 진짜 주인만 쓰는 버튼이다.

const STATUS_LABEL: Record<string, string> = {
  VERIFIED: "검증 완료",
  UNVERIFIED: "검증 대기 (예금주 조회 전)",
  HOLDER_MISMATCH: "예금주 불일치 — 확인 필요",
};

export default async function PayoutProtectionPage() {
  const userId = await getSessionUserId();
  if (!userId) {
    return (
      <>
        <AppHeader title="정산 계좌 보호" backHref="/settings" />
        <main className={marketStyles.page}>
          <p className={styles.notice}>
            로그인이 필요합니다. <Link href="/login">로그인하기</Link>
          </p>
        </main>
      </>
    );
  }

  const view = await payoutAccountView(prisma, userId);

  return (
    <>
      <AppHeader title="정산 계좌 보호" backHref="/settings" />
      <main className={marketStyles.page}>
        <div className={marketStyles.section}>내 정산 계좌</div>
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
            </>
          ) : (
            <div className={styles.statusLine}>
              <span className={styles.statusKey}>계좌</span>
              <span className={styles.statusValue}>등록되지 않음</span>
            </div>
          )}
        </div>

        <div className={marketStyles.section}>계좌가 바뀌면</div>
        <p className={styles.notice}>
          정산 계좌가 변경되면 <strong>보안을 위해 48시간 동안 지급이 유예</strong>되고,
          변경 알림이 갑니다. 그 48시간은 지연이 아니라{" "}
          <strong>본인이 손쓸 수 있는 시간</strong>입니다.
          <br />
          <br />
          <strong>본인이 바꾸지 않았다면 아래 버튼을 누르세요.</strong> 누르는 즉시 이
          계정에서 나가는 모든 돈이 멈추고 운영자가 확인합니다. 계좌가 아직 등록되지 않았어도
          미리 잠글 수 있습니다 — 등록되기 전에 잠그는 것이 가장 이른 방어입니다.
        </p>

        <div className={marketStyles.section}>정산 동결</div>
        <div style={{ padding: "0 16px 24px" }}>
          <FreezeButton initial={view} />
        </div>
      </main>
    </>
  );
}
