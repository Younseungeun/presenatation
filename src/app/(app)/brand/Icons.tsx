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

/** 홈 — 오각형 윤곽 + 채운 문. 문이 바닥선에 붙어 있어 채움이 윤곽과 이어진다.
 *  처마는 그렸다가 잘랐다 — 벽 밖 1.8 토막 둘이 24px에서 발처럼 읽혔다. */
export function HomeIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(0 0.15)">
        <path
          d="M3.2 10.6 L12 3 L20.8 10.6 V18.6 A2.2 2.2 0 0 1 18.6 20.8
             H5.4 A2.2 2.2 0 0 1 3.2 18.6 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path d="M9.2 20.8 V15 A2.8 2.8 0 0 1 14.8 15 V20.8 Z" fill="currentColor" />
      </g>
    </svg>
  );
}

/**
 * 보안 — 자물쇠. 문제는 에스크로 가방이 이미 윤곽 둥근 사각형 + 얹은 것이라는 점.
 * 셋으로 가른다: 반원 고리(8.6×4.3) 대 각진 손잡이(6.4×3.2), 세로 17.5×19 대
 * 가로 20×18, 열쇠구멍 대 선+걸쇠. 몸통이 12.6인 것도 계산이다 — 11.8이면
 * 안쪽 10.0이라 원 4.8 + 슬롯 2.6 앞뒤로 1.7씩을 못 준다.
 * 슬롯은 좁아지지 않는 직선 — 좁히면 원과 붙어 물방울이 된다.
 */
export function SecurityIcon() {
  return (
    <svg {...BOX}>
      <path
        d="M7.7 7.85 A4.3 4.3 0 0 1 16.3 7.85"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <rect
        x="4.2"
        y="7.85"
        width="15.6"
        height="12.6"
        rx="2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12.85" r="2.4" fill="currentColor" />
      <rect x="11.1" y="14.95" width="1.8" height="2.6" rx="0.9" fill="currentColor" />
    </svg>
  );
}

/**
 * 상태 — 다이얼. 아래가 열린 속도계 호는 네 번 그렸고 전부 납작하고 창백했다
 * (18.5×13.8, 잉크 12.6%). 테두리를 닫으니 20×20에 22.4%로 세트에 붙는다.
 * 과녁과 겹치지 않는다 — 저쪽은 끊긴 동심원 둘 + 깃 달린 화살, 이쪽은 링 하나 +
 * 방사 눈금 + 허브에서 뻗은 바늘.
 * 바늘은 67.5°, 45°와 90° 눈금의 한가운데라 양쪽까지 2.0으로 같다.
 * 아래에는 눈금이 없다 — 그게 시계 문자판과 계기판을 가른다.
 */
export function StatusIcon() {
  return (
    <svg {...BOX}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M8.32 15.68 L7.47 16.53" />
        <path d="M6.80 12 L5.60 12" />
        <path d="M8.32 8.32 L7.47 7.47" />
        <path d="M12 6.80 V5.60" />
        <path d="M15.68 8.32 L16.53 7.47" />
        <path d="M17.20 12 H18.40" />
        <path d="M15.68 15.68 L16.53 16.53" />
      </g>
      <path d="M13.76 7.75 L13.66 12.69 L10.34 11.31 Z" fill="currentColor" />
      <circle cx="12" cy="12" r="1.9" fill="currentColor" />
    </svg>
  );
}

/**
 * 돈 — 원화 기호를 든 동전. 지폐는 지갑·가방·정산에 이어 둥근 사각형 넷째가 되고,
 * 기호 단독은 세트에서 유일하게 아무것도 감싸지 않은 아이콘이 된다.
 * 기호 획 2.0 — 안에 든 것이 드는 것보다 무거워야 한다(문의 말풍선과 같은 논리).
 * 가로줄 1.5 — 구조가 아니라 부호라, 1.8이면 세 번째 팔로 읽혀 낙서가 된다.
 * 세트 하한 20px에 가장 먼저 닿는 아이콘이다.
 */
export function MoneyIcon() {
  return (
    <svg {...BOX}>
      <circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path
        d="M7.90 8.20 L10.93 15.80 L12 10.86 L13.07 15.80 L16.10 8.20"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
        <path d="M7.30 10.4 H16.70" />
        <path d="M7.30 13.6 H16.70" />
      </g>
    </svg>
  );
}

/**
 * 간편 비밀번호 — 윤곽 입력창 + 마스킹 점 넷. 자물쇠(보안)는 "닫혀 있다"이고
 * 이건 "코드를 친다"다. 점은 넷 — 로그인 카드가 넷을 그리고, 여섯은 키패드(다른 개념),
 * 셋은 말줄임표로 읽힌다. 가로형 창은 비밀번호 칸이 글줄이라 "여기 입력"이라 말한다.
 */
export function PinIcon() {
  return (
    <svg {...BOX}>
      <rect
        x="2.6"
        y="6.6"
        width="18.8"
        height="10.8"
        rx="3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <g fill="currentColor">
        <circle cx="6.4" cy="12" r="1.45" />
        <circle cx="10.13" cy="12" r="1.45" />
        <circle cx="13.87" cy="12" r="1.45" />
        <circle cx="17.6" cy="12" r="1.45" />
      </g>
    </svg>
  );
}

/**
 * 생체 인증 — 지문. 동심 능선 셋 + 코어 심 + 꼬리 눈금 둘.
 * 아래가 열린 동심 호는 무지개로 읽히므로 셋으로 고쳤다: 코어 심(무지개엔 없는 소용돌이),
 * 꼬리 눈금(좌 2.0·우 1.5 비대칭 — 아치엔 없는 능선 끝), 능선이 폭보다 살짝 높아 손가락
 * 끝 타원. 세트에서 유일하게 채운 덩어리가 없다(지문은 능선). 그래도 획 1.8로 무게를 지킨다.
 */
export function FingerprintIcon() {
  return (
    <svg {...BOX}>
      <g
        transform="translate(0 1.5)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      >
        <path d="M4.01 16.5 A8.4 9.4 0 1 1 19.99 16.5" />
        <path d="M6.29 16.34 A6.2 7 0 1 1 17.57 16.67" />
        <path d="M8.47 15.76 A4 4.6 0 1 1 15.32 16.17" />
        <path d="M12 13.6 V9.2" />
        <path d="M7 14.9 V16.9" />
        <path d="M17 14.9 V16.4" />
      </g>
    </svg>
  );
}

/**
 * 복사하기 — 시트 한 장이 다른 한 장 뒤로 복제된 모양. 복사는 문서 × 2다.
 * document(접힌 모서리 + 줄)·escrow(손잡이 케이스)와 부품이 겹치지만, 이건
 * 민 시트 둘을 어긋나게 겹친 것이고 겹침 자체가 신호다. 접힌 모서리도 손잡이도 없다.
 * 세트가 currentColor 단독이라 뒷장을 흰색으로 채워 가리지 않았다 — 다크 모드에서 깨진다.
 * 대신 뒷장을 가려지지 않는 ㄱ자 브래킷으로만 그리고, 두 끝을 butt 캡으로 앞장 테두리에
 * T자로 맞물렸다. 안쪽 덩어리는 바 셋(문서와 같은 처리) — 뒷장을 통째로 채우면 183단위²로
 * 세트에서 쨍한다.
 */
export function CopyIcon() {
  return (
    <svg {...BOX}>
      <path
        d="M14.4 6.4 V5.8 A2.2 2.2 0 0 0 12.2 3.6 H5.2 A2.2 2.2 0 0 0 3 5.8
           V15.4 A2.2 2.2 0 0 0 5.2 17.6 H9.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="butt"
      />
      <path
        d="M11.8 6.4 H18.8 A2.2 2.2 0 0 1 21 8.6 V18.2 A2.2 2.2 0 0 1 18.8 20.4
           H11.8 A2.2 2.2 0 0 1 9.6 18.2 V8.6 A2.2 2.2 0 0 1 11.8 6.4 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <g fill="currentColor">
        <rect x="12.2" y="9.55" width="6.4" height="1.7" rx="0.85" />
        <rect x="12.2" y="12.95" width="6.4" height="1.7" rx="0.85" />
        <rect x="12.2" y="16.35" width="4.4" height="1.7" rx="0.85" />
      </g>
    </svg>
  );
}

/**
 * 신고 — 경광등. 윤곽 등 + 채운 받침 + 광선 셋.
 * 이름이 report가 아닌 이유: 이 앱에서 리포트는 리서치 리포트다.
 * 어려운 건 종이었다 — 종도 림 위의 돔, 경광등도 받침 위의 돔이다. 셋으로 갈랐다:
 * 광선(종엔 없고, 세트에서 직선을 방사하는 건 이것뿐 — 확성기는 호, 계기판은 원 둘레),
 * 서는 방식(폭 18.4 슬래브 위 vs 림 아래 매달린 추), 비율(폭 10.6 높은 등 vs 폭 11.2
 * 눌린 돔).
 * 광선은 셋. 레퍼런스는 다섯이지만 반지름 4.5에서 46°면 이웃까지 2.0, 27°면 1.5로
 * 24px에서 닫힌다. 획 1.6 — 물건이 아니라 물건이 내보내는 것이라서.
 */
export function SirenIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(0 1.38)">
        <path
          d="M6.7 17 V12.8 A5.3 5.3 0 0 1 17.3 12.8 V17"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <rect x="2.8" y="17" width="18.4" height="3.9" rx="1.3" fill="currentColor" />
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          <path d="M15.24 4.37 L16.60 3.05" />
          <path d="M12 3 V1.1" />
          <path d="M8.76 4.37 L7.40 3.05" />
        </g>
      </g>
    </svg>
  );
}

/**
 * 공지 — 확성기. 벌어진 나팔 + 채운 몸통·손잡이 + 파동 둘.
 * 첫 안은 뿔이 직선 사다리꼴이라 확성기가 아니라 쐐기로 읽혔다. 옆선을 휘어
 * 목에서 붙들었다가 입에서 빠르게 열고(반높이 2.9 → 절반 지점 3.1 → 6.8),
 * 입 가장자리를 1.0 볼록하게 해 잘린 끝이 아니라 구멍으로 읽게 했다.
 * 나머지 절반은 몸통이다 — 뿔에 탭만 붙이면 종이 고깔이고, 확성기는 앰프에
 * 물린 나팔이다. 뒤 3.9×5.4 블록 + 손잡이가 덩어리 35이고 무게도 여기서 온다
 * (없으면 17.6%).
 * 파동 획 1.6 — 물건이 아니라 물건이 내보내는 것이라서. 둘인 이유: 셋은 24px에서
 * 입 바깥이 통째로 회색 얼룩이 됐다.
 */
export function AnnounceIcon() {
  return (
    <svg {...BOX}>
      <g transform="translate(-2.25 0)">
        <path
          d="M6.60 10.61 C11.63 8.93 14.19 6.73 15.33 4.05
             Q18.17 10.31 19.08 17.13
             C16.69 15.46 13.36 14.95 8.20 16.19 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <g fill="currentColor">
          <path d="M3.48 11.71 L7.23 10.64 L8.72 15.83 L4.97 16.91 Z" />
          <path d="M5.55 16.74 L8.72 15.83 L9.91 19.96 L6.73 20.87 Z" />
        </g>
        <g
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        >
          <path d="M19.53 7.75 A2.90 2.90 0 0 1 20.68 11.76" />
          <path d="M21.47 5.42 A5.90 5.90 0 0 1 23.56 12.71" />
        </g>
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
