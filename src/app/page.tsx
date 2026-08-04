import Link from "next/link";
import { prisma } from "@/server/db";
import { getBuyerPurchases } from "@/server/financeQueries";
import { getFreeReports } from "@/server/freeReportService";
import {
  getRecentJudgments,
  getResearcherConsensus,
  getUpcomingDeadlineCards,
} from "@/server/marketQueries";
import { getSessionUserId } from "@/server/session";
import { HomeSignedIn } from "./HomeSignedIn";
import styles from "./page.module.css";

export const dynamic = "force-dynamic";

// 홈은 로그인 여부로 완전히 갈린다.
// - 비로그인: 서비스 가치를 설명하는 랜딩 (검증 중 0건 같은 개인 지표는 의미가 없다)
// - 로그인: 내 검증 현황 + 방금 판정된 카드 + 마감 임박 (HomeSignedIn)

const FEATURES = [
  {
    icon: "🛡️",
    title: "무위험 진입",
    text: "신규 리서처 리포트는 100% 성과 연동. 예측이 틀리면 전액 현금으로 환불됩니다.",
  },
  {
    icon: "📈",
    title: "조작 불가능한 평판",
    text: "예측 카드가 시장 데이터로 자동 판정되어 쌓입니다. 팔로워 수가 아닌 실적입니다.",
  },
  {
    icon: "🎯",
    title: "정직한 신호",
    text: "선결제 비율·등급·수수료가 리서처의 확신도를 그대로 드러냅니다.",
  },
];

export default async function Home() {
  const userId = await getSessionUserId();
  const now = new Date();

  if (userId) {
    const [user, purchases, consensus, freeReports, feed, upcoming] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { penName: true, email: true },
      }),
      getBuyerPurchases(prisma, userId),
      // 히트맵이 코스피 전 종목을 그리므로 컨센서스 표본도 넉넉히 (종목 수 기준)
      getResearcherConsensus(prisma, 100, now),
      getFreeReports(prisma, 4),
      getRecentJudgments(prisma, 6),
      getUpcomingDeadlineCards(prisma, 5, now),
    ]);

    if (user) {
      return (
        <HomeSignedIn
          name={user.penName ?? user.email}
          purchases={purchases}
          consensus={consensus}
          freeReports={freeReports}
          feed={feed}
          upcoming={upcoming}
          now={now}
        />
      );
    }
  }

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <span className={styles.eyebrow}>● 성과 검증형 리서치</span>
        <h1 className={styles.title}>
          맞히는 리서처만 <em>살아남는</em> 리포트 마켓
        </h1>
        <p className={styles.lead}>
          독립 리서처의 주식·코인 분석을 예측 카드로 판매하고, 결과가 시장 데이터로
          자동 판정되어 정산과 평판이 갱신됩니다.
        </p>
        <div className={styles.ctas}>
          <Link className={styles.primary} href="/leaderboard">
            리더보드 둘러보기
          </Link>
          <Link className={styles.secondary} href="/login">
            로그인
          </Link>
        </div>
      </section>

      <section className={styles.cards}>
        {FEATURES.map((f) => (
          <div key={f.title} className={styles.feature}>
            <div className={styles.featureIcon}>{f.icon}</div>
            <div className={styles.featureTitle}>{f.title}</div>
            <div className={styles.featureText}>{f.text}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
