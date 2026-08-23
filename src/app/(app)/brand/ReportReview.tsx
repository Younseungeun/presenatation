// 리포트 검수 일러스트 — brand/intovill/illustration/report-review*.svg의 좌표를 그대로 옮긴
// React 컴포넌트. 원본이 단일 기준이므로 좌표를 직접 고치지 말고 원본을 갱신한 뒤 반영한다.
//
// 크기별로 파일이 나뉜다 (원본 규정): 48px 이상은 본 일러스트, 48px 미만은 소형 전용.
// 소형은 본 컷에서 본문 줄 하나와 차트 막대 하나를 빼고 막대 간격을 11→16으로 벌린 축약본이다
// (40px에서 160 그리드가 4:1로 접히면 11 간격은 1px 미만이라 막대 셋이 한 덩어리로 뭉갠다).
//
// 여기 있는 것은 소형 컷 두 가지 — report-review-icon.svg(밝은 배경) /
// report-review-icon-dark.svg(어두운 배경). 48px 이상 자리가 생기면 본 컷을 별도로 옮긴다.

/** 소형 전용 (48px 미만) — 카드 + 제목·본문 줄 + 3단 차트 + 돋보기 */
export function ReportReviewIcon({
  size = 40,
  tone = 'light',
  className,
}: {
  size?: number;
  /** 놓이는 배경 — 'dark'는 Deep Ink 같은 어두운 면 전용 컷 */
  tone?: 'light' | 'dark';
  className?: string;
}) {
  const dark = tone === 'dark';
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 160 160"
      role="img"
      aria-label="리포트 검수"
    >
      <rect
        x="26"
        y="19"
        width="80"
        height="112"
        rx="8"
        fill={dark ? '#0F2B26' : '#EAFBF6'}
        stroke={dark ? '#0B7A66' : '#9FEBD6'}
        strokeWidth="3"
      />

      <rect x="40" y="37" width="44" height="7" rx="3.5" fill={dark ? '#2FCBA8' : '#12B896'} />
      <rect x="40" y="53" width="52" height="5" rx="2.5" fill={dark ? '#0B7A66' : '#9FEBD6'} />
      <rect x="40" y="65" width="52" height="5" rx="2.5" fill={dark ? '#0B7A66' : '#9FEBD6'} />

      <rect x="40" y="103" width="8" height="14" rx="2" fill={dark ? '#0E9A80' : '#63DCBE'} />
      <rect x="56" y="95" width="8" height="22" rx="2" fill={dark ? '#12B896' : '#2FCBA8'} />
      <rect x="72" y="87" width="8" height="30" rx="2" fill={dark ? '#2FCBA8' : '#12B896'} />

      <path
        d="M121.26 128.26 L130.45 137.45"
        stroke={dark ? '#2FCBA8' : '#12B896'}
        strokeWidth="9"
        strokeLinecap="round"
      />
      <circle
        cx="108"
        cy="115"
        r="17.5"
        fill="none"
        stroke={dark ? '#2FCBA8' : '#12B896'}
        strokeWidth="10.5"
      />
    </svg>
  );
}
