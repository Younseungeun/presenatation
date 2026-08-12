import Link from "next/link";
import type { MarketCard } from "@/server/marketQueries";
import { RankMark } from "../brand/RankMark";
import { DirectionGlyph } from "../DirectionGlyph";
import { salesWindowEnd } from "@/domain/salesWindow";
import { dday } from "../format";
import { assetLabel } from "../MaskedCard";
import { StarRating } from "../StarRating";
import { convictionStars } from "../starSummary";
import { TierChip } from "../TierChip";
import styles from "./leaderboard.module.css";

// "지금 잘 팔리는 카드" — 예측 카드가 아니라 **순위표**로 그린다.
//
// 이 섹션이 파는 것은 카드의 내용이 아니라 "다들 이걸 산다"는 사실이라, 정보의
// 주인공이 판매 건수다. 같은 카드 컴포넌트를 또 늘어놓으면 그 사실이 묻히고
// 화면도 단조로워진다. 숫자를 앞세운 얇은 행이 스캔도 빠르다.
//
// 1~3위는 브랜드 순위 표식(잉크 명도 사다리), 4위 이하는 숫자 텍스트 —
// 표식이 흔해지면 상위 3위의 무게가 사라진다 (브랜드 README §4-5).
//
// 머리줄 = 자산군 + 방향 미니 그래프 + 확신 종합 별점.
//   · "▲ 상승" 문구 대신 미니 그래프 — 방향은 모양이, 수익성은 면 채움 진하기가 맡는다
//   · 별점은 확신 종합(starSummary) — 수익성·신뢰도를 점수 기여 가중(0.21:0.79)으로 접은 값.
//     수익성 몫은 구간 번호가 아니라 **그 구간이 적중 시 버는 크기**로 환산해 넣는다
//   · 글자에 방향색을 입히지 않는다 — "국내주식"이 빨간 글씨면 자산군이 나쁘다는 뜻으로 읽힌다

export function BestSellers({
  cards,
  now,
  ownedIds,
}: {
  cards: MarketCard[];
  now: Date;
  /** 이미 산 카드 — 순위표도 카드 목록이므로 같은 규칙으로 구별한다 */
  ownedIds?: Set<string>;
}) {
  return (
    <ol className={styles.rankList}>
      {cards.map((c, i) => {
        const owned = !!ownedIds?.has(c.reportId);
        return (
        <li key={c.reportId}>
          <Link
            href={`/report/${c.reportId}`}
            className={`${styles.rankRow} ${owned ? styles.rankRowOwned : ""}`}
          >
            <span className={styles.rankNum}>
              {i < 3 ? <RankMark rank={(i + 1) as 1 | 2 | 3} size={24} /> : i + 1}
            </span>
            <span className={styles.rankMain}>
              <span className={styles.rankHead}>
                {assetLabel(c.assetClass)}
                <span className={styles.rankGlyph}>
                  <DirectionGlyph direction={c.direction} profitability={c.profitability} />
                </span>
                {(() => {
                  const stars = convictionStars(c.assetClass, c.confidence, c.profitability);
                  return (
                    stars !== null && (
                      // 이 별은 카드의 별 세 줄 중 하나가 아니라 **둘을 접은 값**이라,
                      // 카드에서 보던 신뢰도 별과 개수가 다르다. 그 사실을 물음으로
                      // 남기지 않도록 title로 붙여 둔다
                      <span
                        className={styles.rankStars}
                        title="확신 종합 — 수익성·신뢰도를 점수 기여만큼 가중해 하나로 접은 별점"
                      >
                        <StarRating stars={stars} label="확신 종합" />
                      </span>
                    )
                  );
                })()}
              </span>
              <span className={styles.rankSub}>
                {c.researcherName}
                <TierChip tier={c.tier} />
                <span className={styles.rankDot} />
                {/* 카드와 같은 규칙 — 구매 전에는 판매 마감을 센다 */}
                {c.publishedAt && c.deadline
                  ? `판매 ${dday(salesWindowEnd(c.publishedAt, c.deadline), now)}`
                  : dday(c.deadline, now)}
              </span>
            </span>
            {/* 이미 산 행은 우측이 값에서 행동으로 바뀐다 — 카드와 같은 규칙.
                판매량은 남긴다: 이 섹션이 파는 것이 "다들 이걸 산다"는 사실이라
                내가 샀다고 해서 그 사실이 사라지지 않는다 */}
            <span className={styles.rankRight}>
              {owned ? (
                <span className={styles.rankOwned}>구매함 →</span>
              ) : (
                <span className={styles.rankPrice}>{c.priceKrw.toLocaleString()}원</span>
              )}
              <span className={styles.rankSales}>{c.salesCount}명 구매</span>
            </span>
          </Link>
        </li>
        );
      })}
    </ol>
  );
}
