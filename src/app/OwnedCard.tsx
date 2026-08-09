import Link from "next/link";
import { computeCardProgress, fillPercent } from "@/domain/cardProgress";
import { ASSET_CLASS_LABEL, type AssetClass, type Direction } from "@/domain/constants";
import type { OwnedCardView } from "@/server/ownedCardViews";
import { VerifiedBadge } from "./brand/VerifiedBadge";
import { dday } from "./format";
import { StockLogo } from "./StockLogo";
import styles from "./ownedCard.module.css";

// 구매한 예측 카드 — **구매 전 카드와 다른 물건이다.**
//
// 구매 전 카드가 답하는 질문은 "살까?"라서 리서처·확신 3종·가격이 주인공이었다.
// 사고 나면 질문이 바뀐다 — **"내 예측 잘 되고 있나?"** 그래서 구성 요소를 통째로
// 바꾼다: 리서처 프로필도 별점도 없애고, 종목·목표·진행만 남긴다.
// (딱지 하나 붙이는 방식으로는 이 질문 전환이 표현되지 않는다)
//
//   종목 로고·이름·자산군 → 목표 수익률 → 상황 막대 → 기한·가격
//
// **배경 궤적을 쓰지 않는다** — 종목명이 보이는 화면의 차트 그림은 "이 종목의 실제
// 시세"로 오인된다(CLAUDE.md §2.1). 그 자리를 회사 로고와 실제 진행 막대가 대신한다.

function fmtPrice(v: number, currency: string): string {
  const digits = v < 100 ? 2 : 0;
  const n = v.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return currency === "USD" ? `$${n}` : `${n}원`;
}

export function OwnedCard({
  v,
  now,
  compact = false,
}: {
  v: OwnedCardView;
  now: Date;
  compact?: boolean;
}) {
  const up = v.direction !== "DOWN";
  const tone = up ? "var(--pos)" : "var(--neg)";
  const p = computeCardProgress({
    basePrice: v.basePrice,
    currentPrice: v.currentPrice,
    targetPrice: v.targetPrice,
    direction: (up ? "UP" : "DOWN") as Direction,
    publishedAt: v.publishedAt,
    deadline: v.deadline,
    now,
  });

  const magnitudePct =
    v.targetType === "RETURN_PCT"
      ? v.targetValue
      : v.basePrice != null && v.basePrice > 0
        ? (Math.abs(v.targetValue - v.basePrice) / v.basePrice) * 100
        : null;

  // 가격 진행을 그릴 수 있는가 — 없으면 막대가 시간 전용으로 내려간다
  const hasPrice = p.achievement !== null;
  const fill = hasPrice ? fillPercent(p.achievement) : p.timeRatio * 100;

  return (
    <Link
      href={`/report/${v.reportId}`}
      className={`${styles.card} ${compact ? styles.compact : ""}`}
    >
      {/* ⓪ 바이라인 — 누가 쓴 무슨 글인가. 산 뒤에도 책임 주체는 남아야 하고,
          제목은 구매로 열린 정보 중 하나다(구매 전에는 종목명이 새어 감춰져 있었다).
          아바타·등급·실적은 "살까?"를 판단하는 재료라 빼고 이름과 제목만 둔다 */}
      <span className={styles.byline}>
        <span className={styles.bylineWho}>
          {v.researcherName}
          {v.careerBadge && <VerifiedBadge size={11} />}
        </span>
        <span className={styles.bylineDot} aria-hidden="true" />
        <span className={styles.bylineTitle}>{v.title}</span>
      </span>

      {/* ① 종목 — 구매로 열린 것 */}
      <span className={styles.head}>
        <StockLogo code={v.ticker} name={v.assetName} size={compact ? 32 : 38} />
        <span className={styles.names}>
          <span className={styles.name}>{v.assetName}</span>
          <span className={styles.meta}>
            {ASSET_CLASS_LABEL[v.assetClass as AssetClass] ?? v.assetClass} · {v.ticker}
          </span>
        </span>
        <span className={styles.claim} style={{ color: tone }}>
          {up ? "▲" : "▼"}
          {magnitudePct !== null && (
            <span className={styles.claimPct}>
              {up ? "+" : "−"}
              {magnitudePct.toFixed(magnitudePct < 10 ? 1 : 0)}%
            </span>
          )}
        </span>
      </span>

      {/* ② 상황 막대 — 가격 진행을 채우고 시간을 마커로 얹는다.
          두 막대로 나누면 정작 중요한 "시간 대비 진도"가 안 보인다 */}
      <span className={styles.bar}>
        <span
          className={styles.barFill}
          style={{
            width: `${fill}%`,
            background: hasPrice
              ? `linear-gradient(to right, color-mix(in srgb, ${tone} 55%, transparent), ${tone})`
              : "color-mix(in srgb, var(--text-faint) 40%, transparent)",
          }}
        />
        {/* 시간 마커 — 가격 막대 위에서만 뜻이 있다 (시간 전용 막대에서는 채움이 곧 시간) */}
        {hasPrice && (
          <span
            className={styles.barTime}
            style={{ left: `${p.timeRatio * 100}%` }}
            aria-hidden="true"
          />
        )}
      </span>

      {/* ③ 막대가 말하는 것을 글로 한 번 더 — 색·위치만으로는 정확한 값이 안 읽힌다.
          긴 카드에서는 이 줄 오른쪽 끝에 구매가가 앉는다 (같은 줄, 반대편) */}
      <span className={styles.readoutRow}>
      <span className={styles.readout}>
        {hasPrice ? (
          <>
            {/* 역방향일 때 "목표까지 385%"는 숫자가 커질수록 가까워 보이는 오독을 낳는다 —
                출발선 뒤에서는 남은 거리가 아니라 상태를 말한다 */}
            <span
              className={styles.readoutMain}
              style={{ color: p.achievement! < 0 ? "var(--text-weak)" : tone }}
            >
              {p.reachedTarget
                ? "목표 도달"
                : p.achievement! < 0
                  ? "아직 반대 방향"
                  : `목표까지 ${Math.round((1 - p.achievement!) * 100)}%`}
            </span>
            <span className={styles.readoutSub}>
              현재 {p.currentReturnPct! >= 0 ? "+" : ""}
              {p.currentReturnPct!.toFixed(1)}% · 시간 {Math.round(p.timeRatio * 100)}% 경과
            </span>
          </>
        ) : (
          <span className={styles.readoutSub}>
            시세 연동 대기 · 기간 {Math.round(p.timeRatio * 100)}% 경과
          </span>
        )}
      </span>
        {!compact && (
          <span className={styles.paid}>{v.priceKrw.toLocaleString()}원에 구매</span>
        )}
      </span>

      {/* 목표 도달은 판정이 아니다 — 시한 전 되돌림이면 실패로 판정된다.
          이 한 줄이 없으면 막대가 결과를 약속하는 것처럼 읽힌다 */}
      {p.reachedTarget && !v.judged && (
        <span className={styles.note}>
          시한({new Date(v.deadline).toLocaleDateString("ko-KR", {
            month: "long",
            day: "numeric",
          })}) 시세로 판정됩니다 — 지금 도달은 확정이 아니에요
        </span>
      )}

      {/* ④ 바닥 — 좌: 언제 결과가 나오나 / 우: 얼마에서 얼마로.
          가격 3종을 오른쪽으로 몬 이유는 세 값이 한 덩어리로 읽혀야 하기 때문이고,
          그 자리를 비우고 나니 "검증 기한"이 좌하단의 주인이 됐다.
          짧은 카드는 가격 3종을 싣지 않으므로 그 자리에 구매가가 남는다 */}
      <span className={styles.foot}>
        <span className={styles.dday}>
          {p.awaitingJudgment && !v.judged ? "판정 대기" : dday(v.deadline, now)}
        </span>
        {compact ? (
          <span className={styles.paid}>{v.priceKrw.toLocaleString()}원에 구매</span>
        ) : (
          v.basePrice != null &&
          v.targetPrice != null && (
            <span className={styles.prices}>
              기준 {fmtPrice(v.basePrice, v.currency)}
              {v.currentPrice != null && ` · 현재 ${fmtPrice(v.currentPrice, v.currency)}`}
              {" · 목표 "}
              <strong style={{ color: tone }}>{fmtPrice(v.targetPrice, v.currency)}</strong>
            </span>
          )
        )}
      </span>
    </Link>
  );
}
