import styles from "./starRating.module.css";

// 자기 평가 지표의 별점 표시.
//
// **신뢰도·안정성 다이얼은 선형이 아니라 승산(odds) 사다리다** — 점수 v3의
// proper scoring 구조에서 신뢰도 c를 거는 것이 한 단계 낮추기보다 유리하려면
// 개선 확률 p ≥ c/(c+1)이어야 한다 (E(c)−E(c−1) = p − (1−p)·c ≥ 0에서).
// 즉 신고값은 "적어도 이 승률을 스스로 믿는다"는 선언이고, 별점은 그 함의
// 승률 × 5로 그린다. 다이얼을 ÷2로 선형으로 그리면(구 방식) 정직한 신고
// (중간 실력자의 최적 신뢰도 1~2)가 전부 별 반 개~한 개로 보였다 — 값이 아니라
// 표시 스케일이 틀렸던 것.
//
//   신뢰도 c → 5·c/(c+1)    : 1→★2.50  3→★3.75  5→★4.17  10→★4.55
//   안정성 s → 5·(s−1)/s    : 1→★0(불참)  2→★2.50  5→★4.00  10→★4.50
// 별 5개는 승률 100%라 도달할 수 없다 — 위로 갈수록 촘촘해지는 것까지가 표시의
// 일부다(4.4→4.5가 3.3→3.7만큼 어렵다). 점수 계산·정산에는 아무 영향이 없다.
// 수익성은 5구간 그대로 별 1~5개 정수 — 구간 번호가 곧 별 개수라 변환이 없다.
//
// 색은 무채색(잉크)이다 — 민트는 플랫폼 검증 전용이라(브랜드 §4-3) 리서처
// 자기 신고 값에 쓰면 "플랫폼이 보증한 수치"로 오해된다.

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
