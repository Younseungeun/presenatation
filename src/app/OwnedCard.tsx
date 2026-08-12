import Link from "next/link";
import { adverseFillPercent, computeCardProgress, fillPercent } from "@/domain/cardProgress";
import { ASSET_CLASS_LABEL, type AssetClass, type Direction } from "@/domain/constants";
import type { OwnedCardView } from "@/server/ownedCardViews";
import { VerifiedBadge } from "./brand/VerifiedBadge";
import { dday } from "./format";
import { StockLogo } from "./StockLogo";
import { TimeGauge } from "./TimeGauge";
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
  const ddayLabel =
    p.awaitingJudgment && !v.judged ? "판정 대기" : dday(v.deadline, now);
  // "판정까지"는 D-n 앞에서만 말이 된다 — "판정까지 오늘 마감"·"판정까지 판정 대기"는
  // 어색하고, 그 두 상태는 문구 자체가 이미 무슨 일인지 말한다.
  // **구매 전 카드는 판매 마감을, 구매 후 카드는 판정 시점을 센다** — 산 사람에게
  // 남은 관심사는 "언제까지 살 수 있나"가 아니라 "언제 결과가 나오나"다
  const showDdayLead = ddayLabel.startsWith("D-");
  // 막대는 **가격 전용**이다 — 시세가 없으면 시간으로 대신 채우지 않고 빈 궤도로 둔다.
  // 채워진 막대가 화면마다 다른 것을 뜻하면 막대를 읽을 때마다 무엇의 진행인지
  // 되물어야 한다 (시간은 우측 상단 눈금이 항상 센다)
  const fill = hasPrice ? fillPercent(p.achievement) : 0;
  // 역방향도 같은 궤도를 채운다 — 붉은색으로. 안 그리면 "아직 아무 일 없음"과
  // "크게 어긋나는 중"이 똑같이 빈 막대라, 나쁜 소식만 안 보이는 화면이 된다
  const adverseFill = hasPrice ? adverseFillPercent(p.achievement) : 0;
  const adverse = adverseFill > 0;
  // **막대 색은 방향이 아니라 결과를 말한다** — 초록 = 목표 쪽, 빨강 = 반대 쪽.
  // 카드의 ▲▼·목표가는 예측 방향(tone)을 그대로 쓰지만, 막대가 답하는 질문은
  // "내 예측 잘 되고 있나?"라 하락 예측이 잘 가는 중이면 초록이어야 맞다
  const barTone = adverse ? "var(--neg)" : "var(--pos)";

  return (
    <Link
      href={`/report/${v.reportId}`}
      className={`${styles.card} ${compact ? styles.compact : ""}`}
    >
      {/* ⓪ 머리글 — **제목이 중심, 리서처는 곁들임.** 신문 헤드라인과 바이라인의 관계다.
          제목은 구매로 열린 정보 중 하나이고(구매 전에는 종목명이 샐까 봐 감춰 뒀다),
          리서처 이름은 산 뒤에도 책임 주체로 남아야 해서 아래에 작게 붙인다.
          아바타·등급·실적은 "살까?"를 판단하는 재료라 여기 없다 */}
      <span className={styles.header}>
        <span className={styles.title}>{v.title}</span>
        <span className={styles.byline}>
          {v.researcherName}
          {v.careerBadge && <VerifiedBadge size={10} />}
        </span>
      </span>

      {/* 시간 경과 — 막대에서 떼어 온 축. 우측 상단에 눈금 4칸으로 선다.
          가격은 연속(막대), 시간은 이산(눈금)이라 형태가 다르므로 겹쳐 읽히지 않는다 */}
      <span className={styles.gaugeSlot}>
        <TimeGauge timeRatio={p.timeRatio} />
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

      {/* ② 상황 막대 — **가격 진행 하나만** 그린다 (시간은 우측 상단 눈금).
          색이 옅은 곳에서 진한 곳으로 넉넉히 건너간다: 폭만으로는 30%와 45%가
          구별되지 않지만 색까지 함께 움직이면 곁눈질로도 잡힌다.
          15% → 45% → 100%로 세 단(중간 단이 없으면 대부분 구간이 흐릿한 채 지난다) */}
      <span className={styles.bar}>
        {/* 채울 것이 없으면 그리지 않는다 — min-width가 만든 3px 조각은 "조금 왔다"로 읽힌다.
            정방향·역방향은 같은 궤도를 쓰되 색이 다르다. 역방향 막대가 끝까지 차는
            지점이 곧 판매 영구 마감선이다(반대로 목표 폭만큼) */}
        {(adverse ? adverseFill : fill) > 0 && (
        <span
          className={styles.barFill}
          style={{
            width: `${adverse ? adverseFill : fill}%`,
            background: `linear-gradient(90deg,
              color-mix(in srgb, ${barTone} 15%, transparent) 0%,
              color-mix(in srgb, ${barTone} 45%, transparent) 42%,
              ${barTone} 100%)`,
          }}
        />
        )}
      </span>

      {/* ③ 막대가 말하는 것을 글로 한 번 더 — 색·위치만으로는 정확한 값이 안 읽힌다.
          긴 카드에서는 이 줄 오른쪽 끝에 구매가가 앉는다 (같은 줄, 반대편) */}
      <span className={styles.readoutRow}>
      <span className={styles.readout}>
        {hasPrice ? (
          <>
            {/* **숫자와 막대가 같은 것을 말해야 한다** — 예전에는 남은 몫(68%)을 적고
                막대는 채운 몫(32%)을 그려서, 둘이 서로의 여집합이라 한눈에 안 들어왔다.
                이제 둘 다 달성률이다.
                역방향은 "−n%"가 아니라 상태로 말한다: 출발선 뒤에서 숫자를 적으면
                커질수록 가까워 보이는 오독이 생긴다 */}
            {/* 역방향도 **숫자로** 말한다 — "아직 반대 방향"만으로는 살짝 빠진 것과
                거의 마감선에 닿은 것이 같은 문장이 된다. 기준은 막대와 같은 눈금
                (반대쪽 100% = 목표 폭만큼 어긋남 = 판매 마감선) */}
            <span className={styles.readoutMain} style={{ color: barTone }}>
              {p.reachedTarget
                ? "목표 도달"
                : adverse
                  ? `목표 반대쪽으로 ${Math.round(adverseFill)}%`
                  : `목표까지 ${Math.round(p.achievement! * 100)}% 달성`}
            </span>
            {/* 시간 경과는 여기서 뺐다 — 우측 상단 눈금이 세므로 두 번 적을 이유가 없다 */}
            <span className={styles.readoutSub}>
              현재 {p.currentReturnPct! >= 0 ? "+" : ""}
              {p.currentReturnPct!.toFixed(1)}%
            </span>
          </>
        ) : (
          <span className={styles.readoutSub}>시세 연동 대기</span>
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

      {/* ④ 바닥.
          긴 카드는 세 값을 한 줄에 몰면 모바일에서 줄바꿈이 나 D-day까지 두 동강 난다.
          그래서 세로로 나누되 순서에 뜻을 담았다 — **어디서 왔나 → 얼마나 남았나 → 어디로 가나**:
            기준·현재 (우)
            D-15     (좌, 크게)
            목표      (우)
          짧은 카드는 가격을 싣지 않으므로 한 줄로 좌 기한 / 우 구매가 그대로 */}
      {compact ? (
        <span className={styles.foot}>
          <span className={styles.dday}>{ddayLabel}</span>
          <span className={styles.paid}>{v.priceKrw.toLocaleString()}원에 구매</span>
        </span>
      ) : (
        <span className={styles.footStack}>
          {/* 기한은 두 가격 줄의 **세로 중앙**에 선다. 셋을 같은 간격으로 쌓으면
              성격이 다른 값(시간 하나 + 가격 둘)이 한 목록처럼 읽힌다 —
              가격 둘을 붙여 한 덩어리로 만들고 기한을 그 옆에 세우면
              "이 구간을 이만큼 남기고 지나는 중"이 한눈에 잡힌다 */}
          <span className={styles.ddayLine}>
            {showDdayLead && <span className={styles.ddayLead}>판정까지</span>}
            {ddayLabel}
          </span>
          <span className={styles.priceStack}>
            {v.basePrice != null && (
              <span className={styles.priceLine}>
                기준 {fmtPrice(v.basePrice, v.currency)}
                {v.currentPrice != null && ` · 현재 ${fmtPrice(v.currentPrice, v.currency)}`}
              </span>
            )}
            {v.targetPrice != null && (
              <span className={styles.priceLine}>
                목표{" "}
                <strong className={styles.targetVal} style={{ color: tone }}>
                  {fmtPrice(v.targetPrice, v.currency)}
                </strong>
              </span>
            )}
          </span>
        </span>
      )}
    </Link>
  );
}
