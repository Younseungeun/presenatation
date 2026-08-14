import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { getOpsMetrics } from "@/server/opsMetrics";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import styles from "./health.module.css";
import shell from "../../researcher/researcher.module.css";

export const dynamic = "force-dynamic";

// 운영 건강 — **매일 아침 한 번 보는 화면.**
//
// 이미 있는 계측(스케줄러 심박·이월 건수·정산 큐)은 전부 "인프라가 죽었는가"를 본다.
// 그게 전부 초록이어도 서비스는 조용히 죽을 수 있다 — 카드가 안 팔리고, 판정이 오래
// 걸리고, 환불받은 사람이 다시 안 오면 **시스템은 완벽하게 동작하면서 망한다.**
// 이 화면이 보는 것은 그쪽이다.
//
// 숫자마다 **"이게 나빠지면 무엇이 무너지는가"를 함께 적는다** — 지표는 보는 사람이
// 뜻을 기억해야 하는 순간 안 보게 된다. 그리고 비율에는 반드시 분모를 붙인다:
// 1건 중 1건이 100%로 뜨면 그건 지표가 아니라 오도다.

export default async function AdminHealthPage() {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const metrics = await getOpsMetrics(prisma);
  const alerts = metrics.filter((m) => m.alert).length;

  return (
    <>
      <AppHeader title="운영 건강" backHref="/settings" />
      <main className={shell.page}>
        <p className={styles.lede}>
          인프라가 아니라 <strong>사업 로직</strong>이 죽어가고 있는지를 봅니다.
          {alerts > 0 ? ` 지금 ${alerts}개가 눈에 띕니다.` : " 지금 눈에 띄는 것은 없습니다."}
        </p>

        <ul className={styles.list}>
          {metrics.map((m) => (
            <li key={m.key} className={m.alert ? `${styles.item} ${styles.alert}` : styles.item}>
              <div className={styles.head}>
                <span className={styles.label}>{m.label}</span>
                <span className={styles.value}>{m.value}</span>
              </div>
              <p className={styles.sample}>{m.sample}</p>
              <p className={styles.meaning}>{m.meaning}</p>
            </li>
          ))}
        </ul>

        <p className={styles.note}>
          문턱은 전부 <strong>초안</strong>입니다 — 운영 데이터가 쌓이면 다시 잡습니다.
          표본이 작은 구간에서는 비율보다 분모를 먼저 보세요.
        </p>
      </main>
    </>
  );
}
