import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { getNotifications } from "@/server/notificationService";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../AppHeader";
import styles from "../market.module.css";
import { MarkAllRead } from "./MarkAllRead";

export const dynamic = "force-dynamic";

// 알림함: 판정·정산 결과 통지. 열람하면 전체 읽음 처리된다 (MarkAllRead).

export default async function NotificationsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login?next=/notifications");

  const notifications = await getNotifications(prisma, userId);

  return (
    <>
      <AppHeader title="알림" backHref="/my" />
      <main className={styles.page}>
      <p className={styles.sub}>예측 카드가 판정되면 결과와 환불·정산 내역을 알려드립니다.</p>
      <MarkAllRead />

      {notifications.length === 0 ? (
        <p className={styles.sub}>아직 알림이 없습니다.</p>
      ) : (
        <div className={styles.list}>
          {notifications.map((n) => {
            const inner = (
              <>
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>
                    {!n.readAt && <span className={styles.unreadDot} aria-label="읽지 않음" />}
                    {n.title}
                  </span>
                  <span className={styles.rowSub}>{n.body}</span>
                </div>
                <span className={styles.rowSub}>
                  {new Date(n.createdAt).toLocaleDateString("ko-KR", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </>
            );
            return n.link ? (
              <Link key={n.id} href={n.link} className={styles.row}>
                {inner}
              </Link>
            ) : (
              <div key={n.id} className={styles.row}>
                {inner}
              </div>
            );
          })}
        </div>
      )}
      </main>
    </>
  );
}
