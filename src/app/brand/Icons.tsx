// 인투빌 UI 아이콘 (브랜드 자산, 좌표 원본 그대로 — 수정 금지).
// 원본: brand/intovill/icons/*.svg · 스킬 assets/icons/
//
// 세트 공통 문법: 24 그리드, 획 1.8, 윤곽선 껍데기 + 안쪽에 더 무거운 덩어리 하나,
// currentColor 단독. 크기 하한 20px — 그 아래에서는 내부 여백이 안티에일리어싱으로 닫힌다.
// 좌표를 여기서 고치지 말 것. brand/intovill/ 원본을 고치고 다시 옮겨 온다.
//
// 획 굵기가 1.8이 아닌 곳은 전부 이유가 있다 (규정 brand/intovill/README.md §4-7):
//   settings 허브 2.4 — 뚫린 허브를 1.8로 두면 잉크가 24.5%까지 떨어져 지갑 옆에서 뜬다
//   pencil 능선·도색선 1.2 — 면의 모서리는 구조가 아니라 접힌 자국이라
//                            1.8이면 칠해진 줄무늬로 읽힌다
// 카드지갑은 WalletIcon.tsx에 따로 있다 (담긴 개수에 따라 상태가 바뀌므로).

const BOX = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  "aria-hidden": true,
} as const;

/** 설정 — 톱니 6개(8개는 24px에서 골이 닫힌다) + 뚫린 허브 */
export function SettingsIcon() {
  return (
    <svg {...BOX}>
      <path
        d="M9.11 6.07 L9.67 3.31 A9 9 0 0 1 14.33 3.31 L14.89 6.07
           A6.6 6.6 0 0 1 15.69 6.53 L18.36 5.64 A9 9 0 0 1 20.69 9.67
           L18.58 11.54 A6.6 6.6 0 0 1 18.58 12.46 L20.69 14.33
           A9 9 0 0 1 18.36 18.36 L15.69 17.47 A6.6 6.6 0 0 1 14.89 17.93
           L14.33 20.69 A9 9 0 0 1 9.67 20.69 L9.11 17.93
           A6.6 6.6 0 0 1 8.31 17.47 L5.64 18.36 A9 9 0 0 1 3.31 14.33
           L5.42 12.46 A6.6 6.6 0 0 1 5.42 11.54 L3.31 9.67
           A9 9 0 0 1 5.64 5.64 L8.31 6.53 A6.6 6.6 0 0 1 9.11 6.07 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="2.4" />
    </svg>
  );
}

/** 알림 — 윤곽 돔 + 솔리드 림 + 추. 추와 림 사이 1.7이 세트 하한 20px을 정한다 */
export function BellIcon() {
  return (
    <svg {...BOX}>
      <path
        d="M6.4 12.2 V8.6 A5.6 5.6 0 0 1 17.6 8.6 V12.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <rect x="3" y="12.2" width="18" height="5.6" rx="2.8" fill="currentColor" />
      <path d="M9.8 19.5 A2.2 2.2 0 0 0 14.2 19.5 Z" fill="currentColor" />
    </svg>
  );
}

/**
 * 내 리포트 · 편집 — 깎은 연필. 도색 몸통 / 맨 나무 45% / 흑심 솔리드의 3톤.
 * 도색 경계가 물결인 것은 원뿔과 각기둥의 교선이 평면이 아니기 때문 (능선에서 위로,
 * 면 한가운데에서 촉 쪽으로). 45° 대각선에 놓여 능선 채널이 픽셀 대각선을 탄다.
 */
export function PenIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(1.25 1.26) rotate(-45 12 12)">
        <path
          d="M6.7 13.6 Q8.5 16 10.33 13.6 Q12 16 13.67 13.6 Q15.5 16 17.3 13.6
             L12 22.6 Z"
          fill="currentColor"
          fillOpacity="0.45"
        />
        <path d="M10 19.2 L14 19.2 L12 22.6 Z" fill="currentColor" />
        <path
          d="M6.7 4 A2.1 2.1 0 0 1 8.8 1.9 H15.2 A2.1 2.1 0 0 1 17.3 4
             V13.6 L12 22.6 L6.7 13.6 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d="M6.7 13.6 Q8.5 16 10.33 13.6 Q12 16 13.67 13.6 Q15.5 16 17.3 13.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M10.33 5.6 V13.4 M13.67 5.6 V13.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="butt"
        />
      </g>
    </svg>
  );
}

/**
 * 적중률 — 화살이 꽂힌 과녁. 화살촉은 파묻혀 보이지 않고 축이 불스아이 안에서 끝난다
 * (촉을 그리면 날아와 꽂힌 게 아니라 꽂아 넣은 핀으로 읽힌다). 중심에서 1.3 벗어나
 * 꽂히고, 링은 축이 지나는 자리에서만 1.4 폭으로 끊긴다. 깃은 사다리꼴.
 */
export function HitRateIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(-0.11 -0.6)">
        <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="butt">
          <path d="M17.74 9.82 A7.9 7.9 0 1 1 16.11 7.54" />
          <path d="M14.9 12.53 A4.35 4.35 0 1 1 13.6 10.05" />
        </g>
        <path
          d="M11.8 13.84 L20.57 5.07"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path
          d="M18.38 9.38 L22.69 7.19 L19.16 6.48 L18.45 2.95 L16.26 7.26 Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}

/** 약관·정책 — 접힌 모서리는 선이 아니라 면. 본문 줄 피치 3.7 (여백 1.9) */
export function DocIcon() {
  return (
    <svg {...BOX}>
      <path
        d="M6.5 2.9 H14.2 L19.2 7.9 V19.6 A1.7 1.7 0 0 1 17.5 21.3 H6.5
           A1.7 1.7 0 0 1 4.8 19.6 V4.6 A1.7 1.7 0 0 1 6.5 2.9 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path d="M14.5 3.9 L18.2 7.6 H14.5 Z" fill="currentColor" />
      <g fill="currentColor">
        <rect x="7.6" y="9.4" width="8.8" height="1.8" rx="0.9" />
        <rect x="7.6" y="13.1" width="8.8" height="1.8" rx="0.9" />
        <rect x="7.6" y="16.8" width="5.6" height="1.8" rx="0.9" />
      </g>
    </svg>
  );
}

/**
 * 에스크로 보관 — 손잡이가 장식이 아니다. 빼면 윤곽 사각형에 솔리드 띠 하나라
 * 24px에서 카드지갑과 헷갈린다. 걸쇠는 띠를 파고들지 않고 위로 1.6 솟는다.
 */
export function EscrowIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(0 0.5)">
        <path
          d="M8.8 6.6 V5.3 A1.9 1.9 0 0 1 10.7 3.4 H13.3 A1.9 1.9 0 0 1 15.2 5.3 V6.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <rect
          x="2.8"
          y="6.6"
          width="18.4"
          height="13"
          rx="2.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M3.7 11.4 H10.2 V9.8 H13.8 V11.4 H20.3 V14.2 H3.7 Z" fill="currentColor" />
      </g>
    </svg>
  );
}
