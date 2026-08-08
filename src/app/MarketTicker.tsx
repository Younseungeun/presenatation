import type { MarketStat } from "@/server/marketStats";
import styles from "./marketTicker.module.css";

// 시장 규모 띠지 — 얇은 띠 안에서 왼쪽으로 흐른다.
//
// 흐르게 하는 이유: 항목이 대여섯 개인데 한 줄에 다 넣으면 글자가 작아져 아무것도 안 읽히고,
// 세로로 쌓으면 얇은 띠가 아니게 된다. 하나씩 지나가면 각 숫자가 제 크기로 읽힌다.
//
// 목록을 두 번 이어 붙이는 것이 이음매 없는 반복의 방법이다 — 첫 벌이 왼쪽으로 완전히
// 빠지는 순간 둘째 벌이 정확히 같은 자리에 와 있어, 되감기는 눈에 보이지 않는다.
// 그래서 애니메이션은 -50%까지만 간다 (한 벌의 폭).
//
// 움직임을 줄이는 설정(prefers-reduced-motion)에서는 흐르지 않고 줄바꿈으로 눕는다 —
// 정보가 사라지면 안 되므로 숨기는 것이 아니라 표현을 바꾼다.

export function MarketTicker({ stats }: { stats: MarketStat[] }) {
  if (stats.length === 0) return null;

  const item = (s: MarketStat, dupe: boolean) => (
    <span className={styles.item} key={`${dupe ? "b" : "a"}-${s.key}`}>
      <span className={styles.label}>{s.label}</span>
      <strong className={styles.value}>{s.value}</strong>
    </span>
  );

  return (
    <div
      className={styles.band}
      role="status"
      aria-label={`마켓 현황: ${stats.map((s) => `${s.label} ${s.value}`).join(", ")}`}
    >
      {/* 흐르는 줄은 장식이라 보조기기에는 위 aria-label 한 줄로 충분하다 */}
      <div className={styles.track} aria-hidden="true">
        <span className={styles.run}>{stats.map((s) => item(s, false))}</span>
        <span className={styles.run}>{stats.map((s) => item(s, true))}</span>
      </div>
    </div>
  );
}
