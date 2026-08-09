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
  if (next.hideOwned) q.set("hideowned", "1");
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

export function FilterBar({
  state,
  matched,
  ownedCount = 0,
}: {
  state: FilterState;
  matched: number;
  /** 지금 화면에 있는 내 구매 카드 수 — 0이면 숨김 칩을 그리지 않는다 */
  ownedCount?: number;
}) {
  const active = Boolean(
    state.refundOnly || state.maxPriceKrw || state.withinDays || state.hideOwned,
  );

  return (
    <div className={styles.filterWrap}>
      <div className={styles.chipRow}>
        {/* 구매한 카드 숨기기 — 다른 칩과 성격이 다르다(카드 속성이 아니라 나와의 관계).
            숨길 것이 없으면 그리지 않는다: 눌러도 아무 일이 없는 칩은 고장으로 읽힌다.
            이 필터만 리더보드 **화면 전체**에 걸린다 — 목록에서만 지우면 레일에 그대로
            남아 "구매한 카드가 보기 싫다"는 목적이 달성되지 않는다 */}
        {(ownedCount > 0 || state.hideOwned) && (
          <Chip
            on={!!state.hideOwned}
            href={hrefWith(state, { hideOwned: !state.hideOwned })}
          >
            구매한 카드 숨기기
          </Chip>
        )}

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
