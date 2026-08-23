// 기관 출신 배지 — brand/intovill/badge-institutional.svg 좌표를 그대로 옮긴 컴포넌트.
// 인증 배지와 같은 로제트 기하에 색만 Deep Ink다 (등급은 로제트 색이 혼자 나른다 —
// 흰 체크는 모든 등급에서 같다).
// 이름 옆에서만 쓴다 — 버튼·필터로 재사용하면 인증의 의미가 희석된다 (브랜드 §4-3).
//
// 어두운 배경에서는 -dark 변형(Paper 로제트 + 먹 체크)으로 바꿔야 한다.
// 지금 앱은 라이트 배경뿐이라 이 한 벌만 옮겼다.

export function InstitutionalBadge({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label="기관 출신 리서처"
      style={{ flexShrink: 0, verticalAlign: "-2px" }}
    >
      <g fill="#0C1E1A">
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
