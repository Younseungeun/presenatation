// 순위 표식 — 브랜드 원본 brand/intovill/leaderboard/rank-{1,2,3}.svg의 좌표 그대로.
// (Logo.tsx와 같은 규칙: 좌표 직접 수정 금지, 원본 갱신 후 반영)
//
// 순위는 색이 아니라 **무게(명도)로 읽힌다** — 1위 Deep Ink 솔리드, 2위 중간 잉크,
// 3위 뮤트 아웃라인. 등급 칩의 아웃라인→틴트→솔리드와 같은 문법이다.
// 1위의 45° 노치 한 쌍이 브랜드 축을 반복하고, 민트는 이 노치에만 쓴다
// (메달을 민트로 채우면 검증 신호와 섞인다 — 브랜드 README §4-5).
// 4위 이하는 표식 없이 숫자 텍스트로 — 표식이 흔해지면 상위 3위의 무게가 사라진다.

const COMMON = {
  viewBox: "0 0 64 64",
  "aria-hidden": true as const,
};

export function RankMark({ rank, size = 24 }: { rank: 1 | 2 | 3; size?: number }) {
  if (rank === 1) {
    return (
      <svg {...COMMON} width={size} height={size}>
        <circle cx="32" cy="32" r="26" fill="#0C1E1A" />
        <path d="M14.2 13.5 L21 20.3" stroke="#12B896" strokeWidth="5" strokeLinecap="round" />
        <path d="M49.8 13.5 L43 20.3" stroke="#12B896" strokeWidth="5" strokeLinecap="round" />
        <path
          d="M27 26 L33.5 21.5 L33.5 45"
          fill="none"
          stroke="#FBFDFC"
          strokeWidth="6"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          strokeMiterlimit="2"
        />
      </svg>
    );
  }
  if (rank === 2) {
    return (
      <svg {...COMMON} width={size} height={size}>
        <circle cx="32" cy="32" r="26" fill="#4A5C57" />
        <path
          d="M23 24.5 A9.5 9.5 0 1 1 40 30.5 L24 45 L41 45"
          fill="none"
          stroke="#FBFDFC"
          strokeWidth="6"
          strokeLinecap="butt"
          strokeLinejoin="miter"
          strokeMiterlimit="2"
        />
      </svg>
    );
  }
  return (
    <svg {...COMMON} width={size} height={size}>
      <g fill="none" stroke="#8B9A96" strokeLinecap="butt" strokeLinejoin="miter" strokeMiterlimit="2">
        <circle cx="32" cy="32" r="23.5" strokeWidth="4.5" />
        <path d="M24 23 A8.5 8.5 0 1 1 32 34 A9 9 0 1 1 23.5 42" strokeWidth="5.5" />
      </g>
    </svg>
  );
}
