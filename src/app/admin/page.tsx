import Link from "next/link";
import { getAdminQueues, type QueueTone } from "@/server/adminQueues";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getStatusBand } from "@/server/statusBand";
import { AdminHead } from "./AdminHead";
import { StatusBand } from "./StatusBand";
import styles from "./admin.module.css";

export const dynamic = "force-dynamic";

// 관리자 홈 — **로그인하면 여기가 첫 화면이다.**
//
// 운영자의 하루는 "어느 큐에 몇 건이 기다리나"로 시작한다. 시안 v3에서 확정한 모양:
// **사람을 기다리는 일**을 색 칠한 타일 넷으로 먼저 보여주고, 그 아래 오늘의 경보.
// 링크 목록이었던 옛 화면과 다른 점은 하나다 — 숫자가 아니라 **급함이 색으로** 먼저 온다.
//
// 타일 색은 화면마다 정해 둔 것이 아니라 **그 화면 안에서 가장 급한 것**을 따른다
// (server/adminQueues.ts가 센다). 오늘 급한 게 없으면 초록이 된다.

const TILE_TONE: Record<QueueTone, string> = {
  neg: styles.tileNeg,
  warn: styles.tileWarn,
  calm: styles.tileCalm,
};

function Tile({
  href,
  label,
  count,
  tone,
  detail,
}: {
  href: string;
  label: string;
  count: number;
  tone: QueueTone;
  detail: string;
}) {
  return (
    <Link href={href} className={`${styles.tile} ${TILE_TONE[tone]}`}>
      <div className={styles.tileK}>{label}</div>
      <div className={styles.tileV}>{count}건</div>
      <div className={styles.tileD}>{detail}</div>
    </Link>
  );
}

export default async function AdminHomePage() {
  const userId = await getSessionUserId();
  const me = userId
    ? await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true, penName: true, email: true },
      })
    : null;
  if (me?.role !== "OPERATOR") {
    return (
      <main className={styles.page}>
        <p style={{ padding: 16 }}>운영자만 볼 수 있는 화면입니다.</p>
      </main>
    );
  }

  const now = new Date();
  // 경보는 **텔레그램으로 나간 것과 같은 목록**이다 (시안 v3) — 지표가 아니라 사건이다.
  // 지표(한 건도 안 팔린 카드 63% 같은 것)는 상태 화면이 답하고, 홈은 "오늘 무슨 일이
  // 있었나"만 답한다. 둘을 섞어 두면 매일 같은 63%가 경보 자리에 앉아 있어,
  // 진짜 사고가 났을 때 그 줄이 눈에 안 걸린다
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const [q, band, alerts] = await Promise.all([
    getAdminQueues(prisma, now),
    getStatusBand(prisma),
    prisma.notification.findMany({
      where: { userId: userId!, type: "OPS_ALERT", createdAt: { gte: dayStart } },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
  ]);

  const today = now.toLocaleDateString("ko-KR", {
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  return (
    <>
      <AdminHead title="운영" sub={`${today} · 창업자 모드`} inbox={q.inbox} />
      <main className={styles.page}>
        {/* 타일 넷이 "사람을 기다리는 일"을 센다면 이 줄은 **기계가 살아 있는가**를
            말한다. 판정이 멈춰 있으면 오늘 건수가 0일 수 있는데, 그 0은
            "일이 없다"가 아니라 "재고 있지 않다"는 뜻이다 */}
        <StatusBand ticks={band} />

        <div className={styles.sec}>사람을 기다리는 일</div>
        <div className={styles.tiles}>
          {/* 부제는 **그 화면의 탭 이름을 그대로** 쓴다 (시안 v3) — 타일을 누르면
              바로 그 탭이 나오므로, 내부 용어로 적으면 눌렀을 때 다른 말이 뜬다.
              맨 앞의 "급한 것"은 그중 빨간 것의 수다 */}
          <Tile
            href="/admin/compliance"
            label="리포트"
            count={q.report.total}
            tone={q.report.tone}
            detail={[
              q.report.suspended > 0 ? `급한 것 ${q.report.suspended}` : null,
              `본문 ${q.report.holds + q.report.abuseGroups}`,
              `종목·시세 ${q.report.manual}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <Tile
            href="/admin/settlements"
            label="돈"
            count={q.money.total}
            tone={q.money.tone}
            detail={[
              q.money.disputes > 0 ? `급한 것 ${q.money.disputes}` : null,
              `${q.money.waitingKrw.toLocaleString()}원 대기`,
            ]
              .filter(Boolean)
              .join(" · ")}
          />
          <Tile
            href="/admin/frozen"
            label="보안"
            count={q.sec.total}
            tone={q.sec.tone}
            detail={[
              q.sec.tickets > 0 ? `문의 ${q.sec.tickets}` : null,
              `명의 확인 ${q.sec.mismatches}`,
            ]
              .filter(Boolean)
              .join(" · ") || "손댈 것 없음"}
          />
          <Tile
            href="/admin/health"
            label="상태"
            count={q.status.total}
            tone={q.status.tone}
            detail={
              [
                q.status.p0 > 0 ? `급한 것 ${q.status.p0}` : null,
                `경보 ${q.status.alerts}`,
              ]
                .filter(Boolean)
                .join(" · ") || "모든 지표 정상"
            }
          />
        </div>

        {/* 경보는 **기계가 아프다는 신호**다. 타일이 "몇 건"을 말한다면 여기는 "무엇이" —
            둘을 합치면 타일이 길어지고, 나누면 훑는 속도가 달라진다 */}
        <div className={styles.sec}>
          오늘의 경보 <small>텔레그램으로 나간 것과 같은 목록</small>
        </div>
        {alerts.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.dot} />
            오늘 나간 경보가 없습니다
          </div>
        ) : (
          <div className={`${styles.card} ${styles.feed}`}>
            {alerts.map((n) => (
              <Link
                key={n.id}
                href={n.link ?? "/admin/health"}
                className={styles.feedRow}
              >
                <span
                  className={`${styles.dot} ${
                    n.title.startsWith("[P0]") || n.title.startsWith("[긴급]")
                      ? styles.dotNeg
                      : styles.dotWarn
                  }`}
                />
                <span className={styles.feedBody}>
                  <span className={styles.feedTitle}>{n.title}</span>
                  <span className={styles.feedMeta}>
                    {new Date(n.createdAt).toLocaleTimeString("ko-KR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                    {n.body ? ` · ${n.body}` : ""}
                  </span>
                </span>
                <span className={styles.feedGo}>›</span>
              </Link>
            ))}
          </div>
        )}

        {/* 시안의 홈은 **여기서 끝난다.** 기록·설정으로 가는 문은 각각 그 일을 하는
            화면 안에 있다(신고 보상은 리포트·본문, 설정은 상태) — 홈에 또 두면 같은
            문이 두 곳에 생기고, 홈이 "무엇부터 가야 하나"만 답하는 화면이 아니게 된다 */}
        <Link href="/" className={styles.xref}>
          <span>
            앱 화면으로 <small>— 이용자가 보는 그대로</small>
          </span>
          <span className={styles.go}>›</span>
        </Link>
      </main>
    </>
  );
}
