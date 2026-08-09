import { ASSET_CLASS_LABEL, TIER_NAME, type AssetClass, type Tier } from "@/domain/constants";
import type { CardQuery } from "@/domain/cardQuery";
import type { MarketCard } from "@/server/marketQueries";
import type { OwnedCardView } from "@/server/ownedCardViews";
import { EmptyState } from "../EmptyState";
import { MaskedCard } from "../MaskedCard";
import { OwnedCard } from "../OwnedCard";
import { TraceNotice } from "../TraceNotice";
import styles from "./leaderboard.module.css";

// 검색 결과.
//
// 조건을 다시 사람 말로 풀어 보여주는 이유: 해시태그는 짧게 쓰라고 만든 문법이라
// "#신뢰도4이상"이 무엇으로 해석됐는지 눈으로 확인할 수 없다. 결과가 예상과 다를 때
// 사용자가 자기 검색어를 고칠 수 있으려면, 시스템이 무엇으로 알아들었는지 말해야 한다.
//
// 못 알아들은 태그도 숨기지 않는다. 특히 종목명(#삼성전자)은 조건이 되지 않는데,
// 조용히 무시하면 "삼성전자 카드만 나왔다"고 오해할 수 있다 — 그게 마스킹 사고다.

function criteriaLabels(q: CardQuery): string[] {
  const out: string[] = [];
  if (q.text) out.push(`리서처 "${q.text}"`);
  for (const a of q.assetClasses) out.push(ASSET_CLASS_LABEL[a as AssetClass] ?? a);
  if (q.direction) out.push(q.direction === "UP" ? "상승 예측" : "하락 예측");
  if (q.minProfitability != null) out.push(`수익성 ★${q.minProfitability} 이상`);
  if (q.minStability != null) out.push(`안정성 ★${q.minStability} 이상`);
  if (q.minConfidence != null) out.push(`신뢰도 ★${q.minConfidence} 이상`);
  if (q.refundOnly) out.push("틀리면 전액 환불");
  if (q.maxPriceKrw != null) out.push(`${q.maxPriceKrw.toLocaleString()}원 이하`);
  if (q.withinDays != null) out.push(`${q.withinDays}일 내 판정`);
  if (q.minTier) out.push(`${TIER_NAME[q.minTier as Tier]} 이상`);
  if (q.verifiedOnly) out.push("경력 인증");
  if (q.newcomerOnly) out.push("판정 이력 없는 신규");
  return out;
}

export function SearchResults({
  query,
  rawQuery,
  results,
  now,
  ownedViews,
}: {
  query: CardQuery;
  rawQuery: string;
  results: MarketCard[];
  now: Date;
  /** 이미 산 카드의 공개 뷰 — 있으면 구성이 다른 카드(OwnedCard)로 그린다 */
  ownedViews: Map<string, OwnedCardView>;
}) {
  const labels = criteriaLabels(query);

  return (
    <section className={styles.searchResults}>
      <div className={styles.resultHead}>
        <span className={styles.resultCount}>
          검색 결과 <strong>{results.length}</strong>장
        </span>
      </div>

      {labels.length > 0 && (
        <div className={styles.criteriaRow}>
          {labels.map((l) => (
            <span key={l} className={styles.criteria}>
              {l}
            </span>
          ))}
        </div>
      )}

      {query.unknown.length > 0 && (
        <p className={styles.unknownNote}>
          <strong>{query.unknown.map((u) => `#${u}`).join(", ")}</strong>는 조건으로 쓸 수 없어
          무시했습니다. 구매 전에는 종목을 공개하지 않기 때문에 <b>종목명으로는 검색할 수
          없습니다</b> — 대신 자산군·방향·확신으로 좁혀보세요.
        </p>
      )}

      {results.length === 0 ? (
        <EmptyState
          compact
          title="조건에 맞는 카드가 없어요"
          body={
            query.unknown.length > 0
              ? "쓸 수 있는 조건만 남기고 다시 검색해보세요."
              : "조건을 하나 빼거나 범위를 넓혀보세요."
          }
        />
      ) : (
        <>
          {results.map((c) => (
            ownedViews.get(c.reportId) ? (
              <OwnedCard key={c.reportId} v={ownedViews.get(c.reportId)!} now={now} />
            ) : (
              <MaskedCard key={c.reportId} c={c} now={now} href={`/report/${c.reportId}`} />
            )
          ))}
          <TraceNotice />
        </>
      )}

      <p className={styles.searchEcho}>검색어: {rawQuery}</p>
    </section>
  );
}
