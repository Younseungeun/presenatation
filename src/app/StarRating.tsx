import styles from "./starRating.module.css";

// 별점 표시 — 세 축이 서로 다른 눈금을 쓴다 (수식은 domain/ratingStars.ts).
//
//   신뢰도 c → c에 선형  : 2→★1  4→★2  6→★3  8→★4  10→★5
//     **사다리가 등비라서 별이 선형이다** (점수 v5) — 신고 승산이 칸당 ×1.73으로
//     오르므로 로그 승산이 c에 선형이고, 따라서 별 한 칸이 어느 구간에서든
//     "승산 ×1.73"이라는 같은 뜻을 갖는다. 눈금이 자리마다 다른 의미를 갖지 않는다.
//     구 스케일(5·c/(c+1) = 함의 승률 × 5)을 버린 이유 둘: ① 함의 승률이 이제
//     카드 난이도 p₀에 따라 달라져 같은 c가 카드마다 다른 별이 된다 ② 목표가 가려진
//     화면에서 별로 크기를 역산할 여지가 생긴다. 정확한 확률은 사양이 보이는
//     자리(리포트 상세·작성 화면)에서 카드마다 따로 적는다.
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
