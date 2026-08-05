import { TIER_LABEL, type Tier } from "@/domain/constants";
import styles from "./tierChip.module.css";

// 리서처 등급 칩 — 브랜드 규격(brand/intovill/README.md §4-4) 준용.
// 텍스트 필. 서열은 색이 아니라 무게 진행(아웃라인 → 틴트 → 솔리드)으로 읽힌다.
// 무채색 잉크 계열만 사용 — 민트는 인증 배지 전용이라 등급에 쓰면 신뢰 신호가 갈라진다.
// 무표기(BRONZE)는 칩 자체를 그리지 않는다: 신입 딱지를 만들지 않기 위한 의도적 공백.

const TONE: Record<Tier, "outline" | "tint" | "solid" | null> = {
  BRONZE: null,
  SILVER: "outline",
  GOLD: "tint",
  PLATINUM: "solid",
  CHALLENGER: "solid",
};

export function TierChip({ tier }: { tier: string }) {
  const tone = TONE[tier as Tier];
  if (!tone) return null;
  return (
    <span className={`${styles.chip} ${styles[tone]}`}>{TIER_LABEL[tier as Tier]}</span>
  );
}
