import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { listPushSubscriptions } from "@/server/pushService";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import marketStyles from "../../market.module.css";
import styles from "./notifications.module.css";
import { PushToggle } from "./PushToggle";

export const dynamic = "force-dynamic";

// 알림 설정 — 기기별로 켜고 끈다.
//
// **잠금화면에 무엇이 뜨는지를 여기서 미리 밝힌다.** 푸시 문구는 알림 본문이 아니라
// 종류에서 만들어지고 금액·종목이 실리지 않는데(domain/pushCopy.ts), 그 사실을 켜기 전에
// 알아야 "알림에 왜 금액이 안 나오지?"가 문의로 오지 않는다.

export default async function NotificationSettingsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const devices = await listPushSubscriptions(prisma, userId);
  const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

  return (
    <>
      <AppHeader title="알림" backHref="/settings" />
      <main className={marketStyles.page} style={{ maxWidth: 720 }}>
        <div className={marketStyles.section}>이 기기</div>
        {vapid ? (
          <PushToggle vapidPublicKey={vapid} />
        ) : (
          <p className={styles.notice}>알림 발송이 아직 설정되지 않았습니다.</p>
        )}

        {devices.length > 0 && (
          <>
            <div className={marketStyles.section}>알림을 받는 기기 {devices.length}대</div>
            <div className={marketStyles.list}>
              {devices.map((d) => (
                <div key={d.id} className={marketStyles.row}>
                  <div>
                    <div>{d.platform === "web" ? "웹 브라우저" : d.platform}</div>
                    <div className={marketStyles.rowSub}>
                      {d.label ?? "이름 없음"} · 최근 {new Date(d.lastSeenAt).toLocaleDateString("ko-KR")}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <div className={marketStyles.section}>잠금화면에 뜨는 내용</div>
        <p className={styles.notice}>
          알림에는 <strong>무슨 일이 있었는지까지만</strong> 적습니다 — &ldquo;환불이 처리됐어요&rdquo;처럼요.
          금액·종목·계좌는 넣지 않습니다. 알림은 <strong>잠금화면에 뜨고, 잠금화면은 옆 사람도 봅니다.</strong>
          <br />
          <br />
          <strong>계좌 변경 알림만 예외</strong>입니다. 무엇을 해야 하는지까지 적습니다 — 본인이 바꾼
          것이 아닐 때 정산을 멈출 수 있는 시간이 그때뿐이라서요.
        </p>
      </main>
    </>
  );
}
