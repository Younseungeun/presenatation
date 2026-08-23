// 인증 배지 — brand/intovill/badge-verified.svg 좌표를 그대로 옮긴 컴포넌트.
// 로제트 + 흰 체크. Mint 700을 쓰는 이유는 흰 체크가 이름 줄 크기(14~20px)에서
// 대비 3:1을 넘기기 위해서다 (Mint 500은 2.47:1로 미달).
// 이름 옆에서만 쓴다 — 버튼·필터로 재사용하면 인증의 의미가 희석된다 (브랜드 §4-3).

export function VerifiedBadge({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="인증 리서처"
      style={{ flexShrink: 0, verticalAlign: "-2px" }}
    >
      <g fill="#0B7A66">
        <circle cx="32" cy="32" r="24.5" />
        <circle cx="54" cy="32" r="9" />
        <circle cx="47.56" cy="47.56" r="9" />
        <circle cx="32" cy="54" r="9" />
        <circle cx="16.44" cy="47.56" r="9" />
        <circle cx="10" cy="32" r="9" />
        <circle cx="16.44" cy="16.44" r="9" />
        <circle cx="32" cy="10" r="9" />
        <circle cx="47.56" cy="16.44" r="9" />
      </g>
      <path
        d="M19.5 33 L28 41.5 L45 24.5"
        fill="none"
        stroke="#FBFDFC"
        strokeWidth="7"
        strokeLinecap="butt"
        strokeLinejoin="miter"
        strokeMiterlimit="2"
      />
    </svg>
  );
}
