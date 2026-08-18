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

/**
 * 알림 — 윤곽 돔 + 윤곽 림 + 솔리드 추. 림은 비어 있다.
 * 채운 슬래브(18×5.6)였을 때 세트에서 가장 큰 덩어리라 연필·문서 옆에서 쨍했다.
 * 림 깊이 4.2 = 획 1.8 + 안쪽 2.4 — 3.8이면 안쪽 2.0이라 20px에서 도로 메워진다.
 */
export function BellIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(0.01 0.13)">
        <path
          d="M6.4 12.2 V8.6 A5.6 5.6 0 0 1 17.6 8.6 V12.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <rect
          x="3.9"
          y="12.6"
          width="16.2"
          height="4.2"
          rx="2.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path d="M9.8 19.5 A2.2 2.2 0 0 0 14.2 19.5 Z" fill="currentColor" />
      </g>
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
      <g transform="translate(-0.1 -0.72)">
        <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="butt">
          <path d="M17.89 9.67 A8.1 8.1 0 1 1 16.26 7.4" />
          <path d="M14.49 12.89 A3.9 3.9 0 1 1 13.28 10.37" />
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
 * 누적 환불 — 영수증 + 되돌아 나가는 화살표. 거래가 되돌려졌다는 뜻.
 * 찢긴 밑변이 세트에 없는 실루엣이라 지갑·가방과 디테일로 구분할 필요가 없다.
 * 화살표는 짧은 직선 — 곡선으로 영수증에 붙였던 안은 24px에서 굽이가 먼저 사라졌고
 * 덩어리도 133로 커졌다(이 안은 94). 톱니는 20px에서 평평해진다.
 */
export function RefundIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(-1.12 0.38)">
        <path
          d="M8.6 20.8 V9.8 A2 2 0 0 1 10.6 7.8 H19.4 A2 2 0 0 1 21.4 9.8 V20.8
             L19.24 18.8 L17.08 20.8 L14.92 18.8 L12.76 20.8 L10.6 18.8 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <g fill="currentColor">
          <rect x="11.6" y="11.4" width="6.8" height="1.7" rx="0.85" />
          <rect x="11.6" y="14.8" width="6.8" height="1.7" rx="0.85" />
        </g>
        <path
          d="M7.4 4.2 H15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <path d="M7.6 1.4 L4 4.2 L7.6 7 Z" fill="currentColor" />
      </g>
    </svg>
  );
}

/**
 * 문의하기 — 말풍선 하나에 물음표 하나. 개수가 뜻이다.
 * 말풍선 둘이 기본형이고 수치도 더 낫지만(덩어리 78 대 115) 이 제품에 없는 채팅을
 * 약속한다 — 문의 화면은 주제를 고르고 정해진 답을 먼저 보여주는 창구다. 헤드셋도
 * 같은 이유로 버렸다(상담원이 없다).
 * 물음표 획만 2.0 — 안쪽 표식이 껍데기보다 무거워야 하고, 더 굵으면 고리 안쪽이
 * 2.5 아래로 내려가 24px에서 닫힌다. 안쪽 간격은 전부 1.7이라 20px까지 읽힌다.
 */
export function SupportIcon() {
  return (
    <svg {...BOX}>
      <path
        d="M6 2.8 H18 A3.2 3.2 0 0 1 21.2 6 V15.2 A3.2 3.2 0 0 1 18 18.4
           H11.4 L6 21.2 V18.4 A3.2 3.2 0 0 1 2.8 15.2 V6 A3.2 3.2 0 0 1 6 2.8 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M9.75 8.65 A2.25 2.25 0 1 1 14.08 9.51 Q13.62 10.1 12 10.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="14.7" r="1.1" fill="currentColor" />
    </svg>
  );
}

/**
 * 에스크로 보관 — 윤곽 케이스·손잡이 + 잠금선 + 그 위에 얹힌 작은 걸쇠.
 * 채운 띠(16.6×2.8)였을 때 세트에서 가장 무거워(27%) 쨍했다. 선 + 걸쇠가 같은 말을
 * 훨씬 적은 덩어리로 한다. 손잡이는 장식이 아니다 — 빼면 24px에서 카드지갑과 헷갈린다.
 */
export function EscrowIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(0.01 0.01)">
        <path
          d="M8.8 7.1 V5.8 A1.9 1.9 0 0 1 10.7 3.9 H13.3 A1.9 1.9 0 0 1 15.2 5.8 V7.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <rect
          x="2.8"
          y="7.1"
          width="18.4"
          height="13"
          rx="2.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M3.4 12.6 H20.6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="butt"
        />
        <rect x="10.2" y="10.3" width="3.6" height="4.2" rx="1" fill="currentColor" />
      </g>
    </svg>
  );
}
