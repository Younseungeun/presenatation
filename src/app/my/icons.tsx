// MY 타일용 라인 아이콘.
//
// 브랜드 세트가 있는 것은 `../brand/Icons`에서 그대로 재수출한다 — 여기에 좌표를
// 복사해 두면 원본이 갱신될 때 둘이 갈라진다. 좌표를 고쳐야 하면 brand/intovill/ 원본을
// 고치고 brand/Icons.tsx로 옮겨 온다.
//
// 아래에 남은 것은 아직 브랜드 자산이 없는 아이콘이다. 세트 문법(24 그리드, 획 1.8,
// currentColor)은 같으므로 나란히 놓아도 어긋나지 않지만, 브랜드 규정의 검증
// (잉크 밀도·최소 여백·크기 하한)은 거치지 않았다.
export {
  BellIcon,
  DocIcon,
  EscrowIcon,
  HitRateIcon,
  PenIcon,
  RefundIcon,
  SettingsIcon,
} from "../brand/Icons";

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

export function BagIcon() {
  return (
    <svg {...S}>
      <path d="M5.5 8h13l-1 11.5a1.5 1.5 0 0 1-1.5 1.4H8a1.5 1.5 0 0 1-1.5-1.4z" />
      <path d="M8.8 8V6.4a3.2 3.2 0 0 1 6.4 0V8" />
    </svg>
  );
}
