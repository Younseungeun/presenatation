// INTOVILL 로고 — brand/intovill/(mark|wordmark|lockup-horizontal).svg의 좌표를 그대로 옮긴
// React 컴포넌트. 원본은 단일 기준(brand/intovill/README.md)이므로 좌표를 직접 고치지 말고
// 원본 파일을 갱신한 뒤 이 파일에 반영한다.
//
// 사용 지침(README §4-2): 락업 안에서는 항상 mono 워드마크(Deep Ink). 심볼이 이미 민트를
// 들고 있어 워드마크까지 민트로 하면 강조점이 둘로 갈린다.

/** 심볼만 — 45° 축의 두 원(시장)과 돋보기 링(리서처). 최소 24px. */
export function IntovillMark({
  size = 24,
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
      aria-label="INTOVILL"
    >
      <circle cx="27.25" cy="27.25" r="20" fill="#9FEBD6" />
      <path
        d="M44.807 36.829 A20 20 0 0 1 36.829 44.807 A7 7 0 0 1 44.807 36.829 Z"
        fill="#0C1E1A"
      />
      <circle cx="43.75" cy="43.75" r="10" fill="none" stroke="#12B896" strokeWidth="6" />
    </svg>
  );
}

/**
 * 수평 락업(심볼 + 워드마크) — 헤더 등 가로로 긴 자리용.
 * height만 넘기면 원본 비율(213.8:40)로 자동 확대·축소된다.
 * 최소 폭 155px 규정 때문에 height 28px 미만에서는 쓰지 않는다(README §5).
 */
export function IntovillLockup({
  height = 32,
  className,
  wordmarkOffsetY = 0,
}: {
  height?: number;
  className?: string;
  /**
   * 워드마크(INTOVILL 글자)만 수직으로 미세 이동 — viewBox 단위(40 = 락업 높이).
   * 심볼 위치·원본 좌표는 그대로 두고 감싸는 그룹만 옮기므로 브랜드 자산 규칙에 어긋나지
   * 않는다. 기본 0 = 원본 락업. 홈 상단처럼 워드마크 아래에 문구를 붙일 때만 쓴다.
   */
  wordmarkOffsetY?: number;
}) {
  const width = (height * 213.8) / 40;
  return (
    <svg
      className={className}
      width={width}
      height={height}
      viewBox="0 0 213.8 40"
      role="img"
      aria-label="INTOVILL"
    >
      <g transform="translate(-5.858 -5.858) scale(0.808081)">
        <circle cx="27.25" cy="27.25" r="20" fill="#9FEBD6" />
        <path
          d="M44.807 36.829 A20 20 0 0 1 36.829 44.807 A7 7 0 0 1 44.807 36.829 Z"
          fill="#0C1E1A"
        />
        <circle cx="43.75" cy="43.75" r="10" fill="none" stroke="#12B896" strokeWidth="6" />
      </g>
      {/* 감싸는 그룹은 미세 이동 전용 — 안쪽 워드마크 좌표는 원본 그대로 */}
      <g transform={`translate(0 ${wordmarkOffsetY})`}>
        <g
          transform="translate(54 8)"
          fill="none"
          stroke="#0C1E1A"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          strokeMiterlimit="2"
        >
          <g strokeWidth="2.8">
            <path d="M1.4 0 L1.4 24" />
            <path d="M8.2 24 L8.2 0 L26.4 24 L26.4 0" />
            <path d="M30.8 1.4 L51.8 1.4" />
            <path d="M41.3 0 L41.3 24" />
            <circle cx="66.3" cy="12" r="11.1" />
          </g>
          <g strokeWidth="7">
            <path d="M85.3 0 L93.8 24 L102.3 0" />
            <path d="M111.3 0 L111.3 24" />
            <path d="M122.3 0 L122.3 20.5 L138.8 20.5" />
            <path d="M143.3 0 L143.3 20.5 L159.8 20.5" />
          </g>
        </g>
      </g>
    </svg>
  );
}

/**
 * 앱 아이콘(라이트) — 둥근 사각형 배경 + 심볼. 스플래시 화면용.
 * 최소 폭 155px 규정을 만족하지 못하는 좁은 자리에서는 IntovillLockup 대신 이걸 쓴다.
 */
export function IntovillAppIcon({
  size = 96,
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
      viewBox="0 0 1024 1024"
      role="img"
      aria-label="INTOVILL"
    >
      <rect width="1024" height="1024" rx="224" fill="#EAFBF6" />
      <g transform="translate(61.85 61.85) scale(14.0671)">
        <circle cx="27.25" cy="27.25" r="20" fill="#9FEBD6" />
        <path
          d="M44.807 36.829 A20 20 0 0 1 36.829 44.807 A7 7 0 0 1 44.807 36.829 Z"
          fill="#0C1E1A"
        />
        <circle cx="43.75" cy="43.75" r="10" fill="none" stroke="#12B896" strokeWidth="6" />
      </g>
    </svg>
  );
}
