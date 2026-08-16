import Link from "next/link";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { listLoginDevices } from "@/server/deviceService";
import { AppHeader } from "../../AppHeader";
import marketStyles from "../../market.module.css";
import styles from "./devices.module.css";
import { DeviceManager } from "./DeviceManager";

export const dynamic = "force-dynamic";

// 로그인 기기 — 생체 로그인이 사는 곳.
//
// 이 화면이 말해야 하는 것 둘:
//   ① 생체 정보가 우리에게 오지 않는다는 사실 (안 적으면 지문을 서버에 보내는 줄 안다)
//   ② 기기 등록이 **계좌 변경과 같은 무게의 사건**이라는 것
//      — 새 기기가 붙으면 그 계정에 새로운 사람이 들어올 수 있다는 뜻이다

export default async function DevicesPage() {
  const userId = await getSessionUserId();
  if (!userId) {
    return (
      <>
        <AppHeader title="로그인 기기" backHref="/settings" />
        <main className={marketStyles.page}>
          <p className={styles.empty}>
            로그인이 필요합니다. <Link href="/login">로그인하기</Link>
          </p>
        </main>
      </>
    );
  }

  const devices = await listLoginDevices(prisma, userId);

  return (
    <>
      <AppHeader title="로그인 기기" backHref="/settings" />
      <main className={marketStyles.page}>
        <div className={marketStyles.section}>등록된 기기</div>
        <DeviceManager initial={devices} />

        <div className={marketStyles.section}>알아두실 것</div>
        <p className={styles.empty}>
          <strong>지문과 얼굴은 저희에게 오지 않습니다.</strong> 기기 안에서만 확인되고,
          저희가 받는 것은 기기가 만든 서명뿐입니다. 이 목록이 통째로 유출돼도 남이 로그인할
          수는 없습니다.
          <br />
          <br />
          <strong>새 기기가 등록되면 알림이 갑니다.</strong> 본인이 등록하지 않은 기기가
          보이면 삭제하고, <Link href="/settings/payout">정산을 동결</Link>해주세요.
          <br />
          <br />
          <strong>기기를 지우면 모든 기기에서 로그아웃됩니다.</strong> 지우기만 하면 그 기기의
          다음 로그인만 막힐 뿐, 이미 열려 있는 창은 그대로 남기 때문입니다. 본인 기기에서는
          다시 로그인하시면 됩니다.
          <br />
          <br />
          기기를 전부 지워도 계정은 잠기지 않습니다 — 휴대폰 본인 인증으로 다시 들어올 수
          있습니다.
        </p>
      </main>
    </>
  );
}
