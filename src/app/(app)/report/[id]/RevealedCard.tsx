import type { PredictionCard } from "@prisma/client";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { magnitudePctToTargetPrice } from "@/domain/scoring";
import { dday } from "@/lib/format";
import { StockLogo } from "../../StockLogo";
import styles from "../../market.module.css";

// 구매로 열린 예측 카드 — **종목이 주인공**.
//
// 구매 전 카드(MaskedCard)와 같은 표에 값만 채우면, 방금 돈을 내고 얻은 것(종목·목표가)이
// 선결제 비율과 같은 무게로 한 줄씩 나열된다. 산 사람에게 가장 큰 자리를 내주는 것이
// "구매 후"라는 상태의 유일한 표현이다.
//
// **배경 궤적을 쓰지 않는다.** 종목명이 함께 보이는 순간 그 그림이 "이 종목의 실제 시세
// 차트"로 읽히기 때문이다 — 궤적을 구매 전 화면에만 두는 규칙(CLAUDE.md §2.1)이 여기서
// 지켜진다. 대신 회사 로고가 그 자리를 대신한다: 종목이 열렸다는 사실 자체가 시각 신호다.
//
// 비율이 아니라 **가격**을 보여준다. 리서처가 판 주장은 "8%"가 아니라 "198,000원에서
// 178,200원까지"이고, 구매자가 실제로 따라 매매할 때 보는 것도 가격이다.
// 목표가 환산은 domain/scoring의 magnitudePctToTargetPrice — 채점이 쓰는 함수의 역함수라
// 화면이 말한 목표가와 판정이 쓸 크기가 어긋날 수 없다.

function fmtPrice(v: number, currency: string): string {
  // 소수점은 통화가 아니라 자릿수로 정한다 — 코인은 1원 미만 호가가 있고 주식은 없다
  const digits = v < 100 ? 2 : 0;
  const n = v.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency === "USD" ? `$${n}` : `${n}원`;
}

export function RevealedCard({ card, now }: { card: PredictionCard; now: Date }) {
  const up = card.direction === "UP";
  const tone = up ? "var(--pos)" : "var(--neg)";
  const assetLabel = ASSET_CLASS_LABEL[card.assetClass as AssetClass] ?? card.assetClass;

  // 목표가: 목표가형은 신고값 그대로, 수익률형은 기준가에서 환산.
  // 기준가가 아직 없는 카드(소급 확정 대기)는 가격을 만들 수 없다 — 지어내지 않는다
  const targetPrice =
    card.targetType === "TARGET_PRICE"
      ? card.targetValue
      : card.basePrice != null
        ? magnitudePctToTargetPrice(card.basePrice, up ? "UP" : "DOWN", card.targetValue)
        : null;

  // 목표 크기(%): 수익률형은 신고값, 목표가형은 기준가 대비 거리
  const magnitudePct =
    card.targetType === "RETURN_PCT"
      ? card.targetValue
      : card.basePrice != null && card.basePrice > 0
        ? (Math.abs(card.targetValue - card.basePrice) / card.basePrice) * 100
        : null;

  return (
    <div className={styles.revealed}>
      {/* ① 종목 — 구매로 열린 것 */}
      <div className={styles.revealedHead}>
        <StockLogo code={card.ticker} name={card.assetName} size={46} />
        <div className={styles.revealedNames}>
          <div className={styles.revealedName}>{card.assetName}</div>
          <div className={styles.revealedTicker}>
            {assetLabel} · {card.ticker}
          </div>
        </div>
      </div>

      {/* ② 주장 — 방향과 크기. 화살표 모양이 방향을 지고 색은 거들 뿐이다 */}
      <div className={styles.revealedClaim} style={{ color: tone }}>
        <span className={styles.revealedDir}>{up ? "▲ 상승" : "▼ 하락"}</span>
        {magnitudePct !== null && (
          <span className={styles.revealedPct}>
            {up ? "+" : "−"}
            {magnitudePct.toFixed(magnitudePct < 10 ? 1 : 0)}%
          </span>
        )}
      </div>

      {/* ③ 가격 — 얼마에서 얼마로. 구매자가 실제로 보는 단위 */}
      <div className={styles.revealedPrices}>
        <div className={styles.revealedPriceCell}>
          <span className={styles.revealedPriceKey}>기준가</span>
          <span className={styles.revealedPriceVal}>
            {card.basePrice != null ? fmtPrice(card.basePrice, card.currency) : "판정 시 확정"}
          </span>
        </div>
        <span className={styles.revealedArrow} style={{ color: tone }} aria-hidden="true">
          →
        </span>
        <div className={styles.revealedPriceCell}>
          <span className={styles.revealedPriceKey}>목표가</span>
          <span className={styles.revealedPriceVal} style={{ color: tone }}>
            {targetPrice != null ? fmtPrice(targetPrice, card.currency) : "—"}
          </span>
        </div>
      </div>

      {/* ④ 언제 결과가 나오나 */}
      <div className={styles.revealedFoot}>
        <span className={styles.revealedDday}>{dday(card.deadline, now)}</span>
        <span className={styles.revealedDeadline}>
          {new Date(card.deadline).toLocaleDateString("ko-KR", {
            year: "2-digit",
            month: "long",
            day: "numeric",
          })}{" "}
          시장가로 자동 판정
        </span>
      </div>
    </div>
  );
}
