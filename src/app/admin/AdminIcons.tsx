// 관리자 콘솔 아이콘 — **브랜드 아이콘 세트(brand/intovill/icons/)를 원본 좌표 그대로** 옮겼다.
//
// 새로 그리지 않는 것이 브랜드 규정이고, 다시 그리면 획 굵기·비례가 미묘하게 어긋나
// 같은 앱 안에서 두 벌의 아이콘이 생긴다. 전부 currentColor 단독이라 색은 부르는 쪽이 정한다.
// 하한 20px 규정 — 탭바·확성기 모두 22px로 쓴다.

export const AdminIcon = {
  home: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g transform="translate(0 0.15)">
        <path
          d="M3.2 10.6 L12 3 L20.8 10.6 V18.6 A2.2 2.2 0 0 1 18.6 20.8 H5.4 A2.2 2.2 0 0 1 3.2 18.6 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path d="M9.2 20.8 V15 A2.8 2.8 0 0 1 14.8 15 V20.8 Z" fill="currentColor" />
      </g>
    </svg>
  ),
  report: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6.5 2.9 H14.2 L19.2 7.9 V19.6 A1.7 1.7 0 0 1 17.5 21.3 H6.5 A1.7 1.7 0 0 1 4.8 19.6 V4.6 A1.7 1.7 0 0 1 6.5 2.9 Z"
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
  ),
  money: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
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
  ),
  sec: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
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
  ),
  status: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
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
  ),
  /* 확성기 — 종(bell)이 아니라 이것을 쓴 이유는 원본 주석에 있다:
     종은 나에게 오는 알림이고, 확성기는 **모두에게 나가는 것**이다 */
  announce: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <g transform="translate(-2.25 0)">
        <path
          d="M6.60 10.61 C11.63 8.93 14.19 6.73 15.33 4.05 Q18.17 10.31 19.08 17.13 C16.69 15.46 13.36 14.95 8.20 16.19 Z"
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
  ),
} as const;
