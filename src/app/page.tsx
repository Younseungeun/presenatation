import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <h1>성과 검증형 리서치 마켓플레이스</h1>
        <p>
          독립 리서처의 주식·기업 분석 리포트를 판매하고, 예측 결과가 시장
          데이터로 자동 판정되어 정산과 평판이 갱신되는 플랫폼입니다.
        </p>
        <ul>
          <li>구매자 무위험 진입 — 신규 리서처 리포트는 100% 성과 연동 (틀리면 환급)</li>
          <li>조작 불가능한 평판 — 예측 카드 + 시장 데이터 자동 판정 트랙레코드</li>
          <li>정직한 신호 체계 — 선결제 비율·등급·수수료로 드러나는 확신도</li>
        </ul>
        <div className={styles.ctas}>
          <Link className={styles.primary} href="/leaderboard">
            리더보드에서 리서처 찾기
          </Link>
        </div>
      </main>
    </div>
  );
}
