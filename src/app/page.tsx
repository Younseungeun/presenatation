import Link from "next/link";
import styles from "./page.module.css";

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

export default function Home() {
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
