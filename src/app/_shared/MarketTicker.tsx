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
// ── 표기 원칙 ────────────────────────────────────────────────
// 띠지는 읽는 것이 아니라 **스치며 잡는 것**이다. 잡히는 순서대로 무게를 준다:
//   ① 증감의 방향 — 색과 화살표. 색은 글자보다 빠르다
//   ② 값          — 가장 크고 진하게
//   ③ 항목명       — 작고 옅게. 값이 무엇인지는 마지막에 확인해도 된다
//
// 괄호를 쓰지 않는다: `(+12)`의 괄호 두 글자에는 정보가 없는데, 흐르는 띠지에서
// 글자 수는 곧 시간이다. 부호(+/−)도 쓰지 않는다 — 화살표가 이미 방향을 말한다.
//
// 화살표는 ↑↓다. ▲▼는 이 앱에서 **예측 방향**(상승·하락 예측)이 이미 쓰고 있어서,
// 마켓 규모의 증감에 같은 글자를 쓰면 두 가지가 한 화면에서 섞인다.

export function MarketTicker({ stats }: { stats: MarketStat[] }) {
  if (stats.length === 0) return null;

  const item = (s: MarketStat, dupe: boolean) => (
    <span className={styles.item} key={`${dupe ? "b" : "a"}-${s.key}`}>
      <span className={styles.label}>{s.label}</span>
      <strong className={styles.value}>{s.value}</strong>
      {s.delta && (
        <span
          className={
            // 좋고 나쁨이 없는 항목은 색을 쓰지 않는다 (에스크로 감소 = 정산 실행)
            s.neutralDelta ? styles.deltaFlat : s.delta.up ? styles.deltaUp : styles.deltaDown
          }
        >
          <span className={styles.arrow} aria-hidden="true">
            {s.delta.up ? "↑" : "↓"}
          </span>
          {s.delta.amount}
        </span>
      )}
    </span>
  );

  return (
    <div
      className={styles.band}
      role="status"
      aria-label={`마켓 현황: ${stats
        .map(
          (s) =>
            `${s.label} ${s.value}${
              s.delta ? ` 어제보다 ${s.delta.amount} ${s.delta.up ? "증가" : "감소"}` : ""
            }`,
        )
        .join(", ")}`}
    >
      {/* 흐르는 줄은 장식이라 보조기기에는 위 aria-label 한 줄로 충분하다 */}
      <div className={styles.track} aria-hidden="true">
        <span className={styles.run}>{stats.map((s) => item(s, false))}</span>
        <span className={styles.run}>{stats.map((s) => item(s, true))}</span>
      </div>
    </div>
  );
}
