// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { listFrozenAccounts } from "@/server/payoutAccountService";
import { AppHeader } from "../../AppHeader";
import marketStyles from "../../market.module.css";
import styles from "../../researcher/researcher.module.css";
import { FrozenList } from "./FrozenList";

export const dynamic = "force-dynamic";

// 정산 동결 관리 — **푸는 쪽의 유일한 창구.**
//
// 거는 것은 본인이 /settings/payout에서 한다. 푸는 것은 여기뿐이고, 여기서도 혼자
// 못 한다 — 승인이 없으면 해제 시도가 승인 요청을 대신 올리고 멈추고, 다른 운영자가
// 승인 대기열에서 승인해야 다음 실행이 통과한다 (2인 승인, 금액 무관 항상).
//
// 동결이 걸린 동안 그 사람에게 나갈 돈이 전부 서 있다 — 오래된 순으로 보여준다.

export default async function FrozenAccountsPage() {
  const userId = await getSessionUserId();
  const me = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    : null;
  if (me?.role !== "OPERATOR") {
    return (
      <>
        <AppHeader title="정산 동결 관리" backHref="/settings" />
        <main className={marketStyles.page}>
          <p className={styles.sub}>운영자만 볼 수 있는 화면입니다.</p>
        </main>
      </>
    );
  }

  const frozen = await listFrozenAccounts(prisma);

  return (
    <>
      <AppHeader title="정산 동결 관리" backHref="/settings" />
      <main className={styles.page}>
        <div className={styles.header}>
          <p className={styles.sub}>
            본인이 &ldquo;내가 바꾸지 않았다&rdquo;고 신고한 계정들입니다. 동결 동안 이
            사람에게 나갈 돈은 전부 멈춰 있습니다. <strong>해제 전에 반드시 본인 확인</strong>을
            거치세요 — 계정을 쥔 탈취자의 요청과 진짜 본인의 요청은 화면에서 구별되지
            않습니다(유선 통화 등 앱 밖 경로로 확인).
          </p>
        </div>
        <FrozenList initial={frozen} />
      </main>
    </>
  );
}
