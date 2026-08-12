import styles from "./starRating.module.css";

// 별점 표시 — 세 축이 서로 다른 눈금을 쓴다 (수식은 domain/ratingStars.ts).
//
//   신뢰도 c → 5·c/(c+1)  : 1→★2.50  3→★3.75  5→★4.17  10→★4.55
//     **다이얼은 선형이 아니라 승산(odds) 사다리다** — c를 거는 것이 한 단계
//     낮추기보다 유리하려면 승률 p ≥ c/(c+1)이어야 하므로(E(c)−E(c−1) ≥ 0),
//     신고값은 "적어도 이 승률을 스스로 믿는다"는 선언이고 별은 그 함의 승률 × 5다.
//     ÷2로 선형으로 그리던 구 방식은 정직한 신고를 전부 별 한 개로 보이게 했다.
//     별 5개(승률 100%)는 도달 불가 — 위로 갈수록 촘촘해지는 것까지가 표시의 일부다.
//   수익성  → 5구간 정수 (구간 번호가 곧 별 개수)
//   안정성  → 5구간 정수. **자기 신고가 아니라 종목의 실현 변동성**을 접은 값이라
//     (domain/stability.ts) 승산 사다리와 무관하다. 구 안정성 다이얼(5·(s−1)/s)은
//     점수 v4에서 폐지됐다.
// 점수 계산·정산에는 아무 영향이 없다.
//
// 색은 무채색(잉크)이다 — 민트는 플랫폼 검증 전용이라(브랜드 §4-3) 여기 쓰면
// "플랫폼이 보증한 수치"로 오해된다.

// 스케일 자체는 domain/ratingStars.ts가 단일 기준으로 들고 있다 (표시·정렬·융합
// 별점이 전부 같은 수식을 쓰게). 여기서는 화면이 쓰기 편하게 다시 내보내기만 한다.
export { confidenceStars } from "@/domain/ratingStars";

export function StarRating({
  stars,
  label,
}: {
  /** 0~5, 0.5 단위 */
  stars: number;
  /** 스크린리더용 항목명 (예: "신뢰도") */
  label: string;
}) {
  const clamped = Math.max(0, Math.min(5, stars));
  // 가중 평균 별점(starSummary)은 긴 소수가 나온다 — 읽어 주는 값은 한 자리면 충분하다
  const spoken = Math.round(clamped * 10) / 10;
  return (
    <span
      className={styles.stars}
      role="img"
      aria-label={`${label} 별 5개 중 ${spoken}개`}
    >
      <span className={styles.track} aria-hidden="true">
        ★★★★★
      </span>
      <span className={styles.fill} style={{ width: `${(clamped / 5) * 100}%` }} aria-hidden="true">
        ★★★★★
      </span>
    </span>
  );
}
