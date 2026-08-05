import Link from "next/link";
import { redirect } from "next/navigation";
import { getCart, issueMessage } from "@/server/cartService";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../AppHeader";
import { EmptyState } from "../EmptyState";
import { CheckoutButton, RemoveButton } from "./CartActions";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

// 장바구니 — 담아둔 리포트를 한 번에 결제한다.
// 담은 뒤 상태가 바뀐 건(시한 경과·판매 종료·이미 구매)은 결제 대상에서 빠지고 사유를 보여준다.

function fmtDate(d: Date): string {
  return new Date(d).toLocaleDateString("ko-KR", {
    year: "2-digit",
    month: "short",
    day: "numeric",
  });
}

export default async function CartPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login?next=/cart");

  const { entries, payableKrw, payableCount } = await getCart(prisma, userId);
  const blocked = entries.filter((e) => e.issue !== null).length;

  return (
    <>
      <AppHeader title="장바구니" backHref="/my" />
      <main className={styles.page}>
        {entries.length === 0 ? (
          <EmptyState
            title="장바구니가 비어 있어요"
            actionHref="/leaderboard"
            actionLabel="리더보드에서 리서처 둘러보기"
          />
        ) : (
          <>
            <p className={styles.sub}>
              담은 {entries.length}건 중 {payableCount}건 결제 가능
              {blocked > 0 && ` · ${blocked}건은 결제할 수 없습니다`}
            </p>

            {entries.map((e) => (
              <div
                key={e.reportId}
                className={styles.reportCard}
                style={e.issue ? { opacity: 0.6 } : undefined}
              >
                <div className={styles.reportTitle}>
                  <Link href={`/report/${e.reportId}`}>{e.title}</Link>
                </div>
                <div className={styles.meta}>
                  <span>{e.researcherName}</span>
                  {e.assetName && <span>{e.assetName}</span>}
                  {e.deadline && <span>시한 {fmtDate(e.deadline)}</span>}
                </div>
                <div className={styles.cartRow}>
                  <span className={styles.cartPrice}>{e.priceKrw.toLocaleString()}원</span>
                  <RemoveButton reportId={e.reportId} />
                </div>
                {e.issue && (
                  <p className={styles.cartIssue}>{issueMessage(e.issue)}</p>
                )}
              </div>
            ))}

            <CheckoutButton payableCount={payableCount} payableKrw={payableKrw} />
          </>
        )}
      </main>
    </>
  );
}
