import { redirect } from "next/navigation";
import { getCart, issueMessage } from "@/server/cartService";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../AppHeader";
import { EmptyState } from "../EmptyState";
import { fmtDate } from "../format";
import { MaskedCard } from "../MaskedCard";
import { TraceNotice } from "../TraceNotice";
import { CheckoutButton, RemoveButton } from "./CartActions";
import styles from "../market.module.css";

export const dynamic = "force-dynamic";

// 카드지갑 — 담아둔 리포트를 한 번에 결제한다. (제품 명칭 2026-08-09 변경:
// 장바구니 → 카드지갑. 아이콘이 카드지갑이라 이름도 그에 맞춘다. 경로 /cart와
// 코드 식별자 cart*는 유지 — 이름은 화면의 것, 식별자는 코드의 것)
// 담은 뒤 상태가 바뀐 건(시한 경과·판매 종료·이미 구매)은 결제 대상에서 빠지고 사유를 보여준다.

export default async function CartPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login?next=/cart");

  const now = new Date();
  const { entries, payableKrw, payableCount } = await getCart(prisma, userId, now);
  const blocked = entries.filter((e) => e.issue !== null).length;

  return (
    <>
      <AppHeader title="카드지갑" backHref="/my" />
      <main className={styles.page}>
        {entries.length === 0 ? (
          <EmptyState
            title="카드지갑이 비어 있어요"
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
              <div key={e.reportId} style={e.issue ? { opacity: 0.6 } : undefined}>
                <MaskedCard
                  c={e}
                  now={now}
                  href={`/report/${e.reportId}`}
                  footer={
                    <div className={styles.cartRow}>
                      {e.deadline && <span>시한 {fmtDate(e.deadline)}</span>}
                      <RemoveButton reportId={e.reportId} />
                    </div>
                  }
                />
                {e.issue && <p className={styles.cartIssue}>{issueMessage(e.issue)}</p>}
              </div>
            ))}

            <TraceNotice />

            <CheckoutButton payableCount={payableCount} payableKrw={payableKrw} />
          </>
        )}
      </main>
    </>
  );
}
