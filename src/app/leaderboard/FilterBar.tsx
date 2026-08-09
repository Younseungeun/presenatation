import Link from "next/link";
import {
  BUDGET_OPTIONS,
  WITHIN_DAY_OPTIONS,
  type MarketFilter,
  type MarketSort,
} from "@/server/marketQueries";
import styles from "./leaderboard.module.css";

// 카드 필터 — 정렬이 순서를 바꾼다면 필터는 후보를 줄인다.
// 정렬만 있으면 예산 밖의 카드가 아래로 밀릴 뿐 사라지지 않아 훑는 양이 그대로다.
//
// 축마다 하나씩만 고를 수 있고(예산 1만/3만 동시 선택은 뜻이 없다), 축끼리는 겹쳐 걸린다.
// 상태는 전부 URL에 있다 — 뒤로가기로 이전 조건이 복원되고, 링크로 공유된다.
// 그래서 클라이언트 상태가 없고 이 컴포넌트는 서버에서 그려진다.

export interface FilterState extends MarketFilter {
  asset: string;
  sort: MarketSort;
}

/** 지금 조건에서 한 축만 바꾼 URL — 같은 값을 다시 누르면 해제된다(토글) */
function hrefWith(s: FilterState, patch: Partial<MarketFilter>): string {
  const next = { ...s, ...patch };
  const q = new URLSearchParams({ asset: next.asset, sort: next.sort });
  if (next.refundOnly) q.set("refund", "1");
  if (next.maxPriceKrw) q.set("budget", String(next.maxPriceKrw));
  if (next.withinDays) q.set("within", String(next.withinDays));
  return `/leaderboard?${q}`;
}

function Chip({
  on,
  href,
  children,
}: {
  on: boolean;
  href: string;
  children: React.ReactNode;
}) {
  return (
    // scroll={false} — 필터는 보던 목록을 좁히는 조작이라 화면이 맨 위로 튀면
    // 방금 보던 자리를 잃는다. 결과는 그 자리에서 바뀐다
    <Link
      href={href}
      scroll={false}
      className={`${styles.chip} ${on ? styles.chipOn : ""}`}
      aria-pressed={on}
    >
      {children}
    </Link>
  );
}

export function FilterBar({ state, matched }: { state: FilterState; matched: number }) {
  const active = Boolean(state.refundOnly || state.maxPriceKrw || state.withinDays);

  return (
    <div className={styles.filterWrap}>
      <div className={styles.chipRow}>
        {/* 무위험 진입은 이 서비스의 1번 차별화인데 지금껏 카드마다 확인해야 했다.
            축으로 만들면 "잃을 게 없는 카드만" 한 번에 좁혀진다 */}
        <Chip
          on={!!state.refundOnly}
          href={hrefWith(state, { refundOnly: !state.refundOnly })}
        >
          틀리면 100% 환불
        </Chip>

        {BUDGET_OPTIONS.map((won) => (
          <Chip
            key={won}
            on={state.maxPriceKrw === won}
            href={hrefWith(state, { maxPriceKrw: state.maxPriceKrw === won ? null : won })}
          >
            {(won / 10_000).toLocaleString()}만원 이하
          </Chip>
        ))}

        {WITHIN_DAY_OPTIONS.map((days) => (
          <Chip
            key={days}
            on={state.withinDays === days}
            href={hrefWith(state, { withinDays: state.withinDays === days ? null : days })}
          >
            {days === 7 ? "일주일 내 판정" : "한 달 내 판정"}
          </Chip>
        ))}
      </div>

      {active && (
        <div className={styles.filterFoot}>
          <span className={styles.filterCount}>{matched}장</span>
          <Link
            href={`/leaderboard?asset=${state.asset}&sort=${state.sort}`}
            scroll={false}
            className={styles.filterReset}
          >
            필터 해제
          </Link>
        </div>
      )}
    </div>
  );
}
