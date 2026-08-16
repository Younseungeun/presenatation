// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import Link from "next/link";
import { cookies } from "next/headers";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { payoutAccountView } from "@/server/payoutAccountView";
import { isTrustedDevice } from "@/server/pinService";
import { AppHeader } from "../../AppHeader";
import marketStyles from "../../market.module.css";
import styles from "./payout.module.css";
import { PayoutPanel } from "./PayoutPanel";

export const dynamic = "force-dynamic";

// 정산 계좌 — **등록·보호·동결이 한 화면에 있다.**
//
// 나누지 않는 이유: 계좌를 등록하러 온 사람과 "내가 안 바꿨는데"를 신고하러 온 사람이
// 찾는 곳이 같기 때문이다. 급한 쪽이 화면을 헤매지 않아야 한다.
//
// 그리고 동결 장치는 **숨기지 않는다.** 탈취자가 알아도 해가 없다 — 해커의 목적은 돈을
// 빼는 것인데 동결은 돈을 막고 운영자를 부른다. 누를 유인이 없고, 푸는 권한은 운영자에게만
// 있어 눌러도 얻을 것이 없다. 그래서 크게 적는 편이 낫다.

export default async function PayoutProtectionPage() {
  const userId = await getSessionUserId();
  if (!userId) {
    return (
      <>
        <AppHeader title="정산 계좌" backHref="/settings" />
        <main className={marketStyles.page}>
          <p className={styles.notice}>
            로그인이 필요합니다. <Link href="/login">로그인하기</Link>
          </p>
        </main>
      </>
    );
  }

  // 이 화면이 평소 기기에서 열렸는지에 따라 유예 확인 번호를 **보여줄지, 입력받을지**가
  // 갈린다 — 번호는 낯선 기기에, 입력은 평소 기기에 (payoutAccountView 주석)
  const store = await cookies();
  const trusted = await isTrustedDevice(prisma, userId, store.get("rm_device")?.value);
  const view = await payoutAccountView(prisma, userId, trusted);

  return (
    <>
      <AppHeader title="정산 계좌" backHref="/settings" />
      <main className={marketStyles.page}>
        <div className={marketStyles.section}>내 정산 계좌</div>
        <PayoutPanel initial={view} />

        <div className={marketStyles.section}>계좌가 바뀌면</div>
        <p className={styles.notice}>
          정산 계좌가 변경되면 <strong>보안을 위해 48시간 동안 지급이 유예</strong>되고,
          변경 알림이 갑니다. 그 48시간은 지연이 아니라{" "}
          <strong>본인이 손쓸 수 있는 시간</strong>입니다.
          <br />
          <br />
          <strong>본인이 바꾸지 않았다면 정산 동결을 누르세요.</strong> 누르는 즉시 이
          계정에서 나가는 모든 돈이 멈추고 운영자가 확인합니다. 계좌가 아직 등록되지 않았어도
          미리 잠글 수 있습니다 — 등록되기 전에 잠그는 것이 가장 이른 방어입니다.
        </p>

        <div className={marketStyles.section}>왜 이름을 안 묻나요</div>
        <p className={styles.notice}>
          예금주 이름은 <strong>직접 입력받지 않습니다.</strong> 통신사가 확인해 준 이름과
          은행이 알려 준 예금주 이름을 저희가 맞춰봅니다. 본인이 두 곳에 다 적으면 그건
          대조가 아니라 받아쓰기라서요.
          <br />
          <br />
          두 이름이 다르면 지급이 멈추고 운영자가 확인합니다. 오타일 수도, 다른 사람 계좌일
          수도 있어서 자동으로 결론짓지 않습니다.
        </p>
      </main>
    </>
  );
}
