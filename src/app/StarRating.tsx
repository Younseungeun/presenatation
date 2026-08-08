import styles from "./starRating.module.css";

// 자기 평가 지표의 별점 표시 — 별 5개, 반 개 = 0.5점.
//
// 신뢰도·안정성은 1~10이라 2로 나눠 별 0.5~5.0개가 되고(반 개 단위가 나온다),
// 수익성은 5구간이라 별 1~5개로 딱 떨어진다(반 개가 나오지 않는다).
//
// 색은 무채색(잉크)이다 — 민트는 플랫폼 검증 전용이라(브랜드 §4-3) 리서처
// 자기 신고 값에 쓰면 "플랫폼이 보증한 수치"로 오해된다.

/** 1~10 스케일 → 별 개수 (반 개 단위) */
export function tenScaleToStars(value: number): number {
  return value / 2;
}

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
  return (
    <span
      className={styles.stars}
      role="img"
      aria-label={`${label} 별 5개 중 ${clamped}개`}
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
