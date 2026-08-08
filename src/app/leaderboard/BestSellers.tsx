import Link from "next/link";
import type { MarketCard } from "@/server/marketQueries";
import { dday } from "../format";
import { maskedHeadline } from "../MaskedCard";
import { TierChip } from "../TierChip";
import styles from "./leaderboard.module.css";

// "지금 잘 팔리는 카드" — 예측 카드가 아니라 **순위표**로 그린다.
//
// 이 섹션이 파는 것은 카드의 내용이 아니라 "다들 이걸 산다"는 사실이라, 정보의
// 주인공이 판매 건수다. 같은 카드 컴포넌트를 또 늘어놓으면 그 사실이 묻히고
// 화면도 단조로워진다. 숫자를 앞세운 얇은 행이 스캔도 빠르다.

export function BestSellers({ cards, now }: { cards: MarketCard[]; now: Date }) {
  return (
    <ol className={styles.rankList}>
      {cards.map((c, i) => (
        <li key={c.reportId}>
          <Link href={`/report/${c.reportId}`} className={styles.rankRow}>
            <span className={styles.rankNum}>{i + 1}</span>
            <span className={styles.rankMain}>
              <span
                className={styles.rankHead}
                style={{ color: c.direction === "UP" ? "var(--pos)" : "var(--neg)" }}
              >
                {maskedHeadline(c)}
              </span>
              <span className={styles.rankSub}>
                {c.researcherName}
                <TierChip tier={c.tier} />
                <span className={styles.rankDot} />
                {dday(c.deadline, now)}
              </span>
            </span>
            <span className={styles.rankRight}>
              <span className={styles.rankPrice}>{c.priceKrw.toLocaleString()}원</span>
              <span className={styles.rankSales}>{c.salesCount}명 구매</span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}
