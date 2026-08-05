// 리포트 검수 일러스트 — brand/intovill/illustration/report-review*.svg의 좌표를 그대로 옮긴
// React 컴포넌트. 원본이 단일 기준이므로 좌표를 직접 고치지 말고 원본을 갱신한 뒤 반영한다.
//
// 크기별로 파일이 나뉜다 (원본 규정): 48px 이상은 본 일러스트, 20~40px는 소형 전용.
// 작은 자리에서 본 일러스트를 줄이면 본문 줄과 막대그래프가 뭉개지기 때문이다.

/** 소형 전용 (20~40px) — 카드 실루엣 + 제목 줄 하나 + 두꺼운 돋보기 */
export function ReportReviewIcon({
  size = 40,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="리포트 검수"
    >
      <rect x="5" y="4" width="32" height="44" rx="4" fill="#9FEBD6" />
      <rect x="11" y="12" width="20" height="5" rx="2.5" fill="#12B896" />
      <path d="M50.9 51.9 L56 57" stroke="#12B896" strokeWidth="7" strokeLinecap="round" />
      <circle cx="41" cy="42" r="12" fill="none" stroke="#12B896" strokeWidth="8" />
    </svg>
  );
}
