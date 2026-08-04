// MY 타일용 라인 아이콘 — 이모지 대신 SVG로 통일 (선 굵기·크기 규격 동일)
const S = {
  width: 24,
  height: 24,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function EscrowIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="7" width="18" height="12" rx="2.5" />
      <path d="M3 11h18" />
      <path d="M12 3.5 8.5 7h7z" />
    </svg>
  );
}

export function RefundIcon() {
  return (
    <svg {...S}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4h-4" />
      <path d="M9.5 10h5M9.5 14h5M11 8l2 8M13 8l-2 8" />
    </svg>
  );
}

export function HitRateIcon() {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function BellIcon() {
  return (
    <svg {...S}>
      <path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5S6.5 14 6.5 10z" />
      <path d="M10.2 18.5a2 2 0 0 0 3.6 0" />
    </svg>
  );
}

export function PenIcon() {
  return (
    <svg {...S}>
      <path d="M15.5 4.5l4 4L9 19H5v-4z" />
      <path d="M13.5 6.5l4 4" />
    </svg>
  );
}

export function PayoutIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="6.5" width="18" height="12" rx="2.5" />
      <circle cx="12" cy="12.5" r="2.8" />
      <path d="M6.5 12.5h.01M17.5 12.5h.01" />
    </svg>
  );
}

export function SlotIcon() {
  return (
    <svg {...S}>
      <rect x="3.5" y="4.5" width="7" height="7" rx="1.6" />
      <rect x="13.5" y="4.5" width="7" height="7" rx="1.6" />
      <rect x="3.5" y="14.5" width="7" height="5" rx="1.6" />
      <path d="M14.5 17h5.5M17.25 14.5v5" />
    </svg>
  );
}

export function ScoreIcon() {
  return (
    <svg {...S}>
      <path d="M4 18l4.5-5 3.5 3.2L20 8" />
      <path d="M15.5 8H20v4.5" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg {...S}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 1 1-4 0v-.11a1.6 1.6 0 0 0-1.05-1.46 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 1 1 0-4h.11a1.6 1.6 0 0 0 1.46-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.47 1z" />
    </svg>
  );
}

export function BagIcon() {
  return (
    <svg {...S}>
      <path d="M5.5 8h13l-1 11.5a1.5 1.5 0 0 1-1.5 1.4H8a1.5 1.5 0 0 1-1.5-1.4z" />
      <path d="M8.8 8V6.4a3.2 3.2 0 0 1 6.4 0V8" />
    </svg>
  );
}

export function DocIcon() {
  return (
    <svg {...S}>
      <path d="M6 3.5h8L18.5 8v12.5H6z" />
      <path d="M13.5 3.5V8h5" />
      <path d="M9 12.5h6M9 16h4" />
    </svg>
  );
}
