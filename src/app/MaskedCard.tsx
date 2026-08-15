import Link from "next/link";
import { showsHitRate, hitRateLabel } from "@/domain/trackRecord";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import type { ProfitabilityLevel } from "@/domain/profitability";
import type { StabilityLevel } from "@/domain/stability";
import { DefaultAvatar } from "./Avatar";
import { VerifiedBadge } from "./brand/VerifiedBadge";
import {
  periodBucketOf,
  TRACE_VIEWBOX,
  traceArea,
  traceLine,
  traceLineJoin,
  type PeriodBucket,
} from "./directionTrace";
import { salesWindowEnd } from "@/domain/salesWindow";
import { dday, directionLabel } from "./format";
import { confidenceStars, StarRating } from "./StarRating";
import { TierChip } from "./TierChip";
import styles from "./maskedCard.module.css";

// 구매 전 예측 카드 — 목록·레일·프로필·장바구니 전부 이 한 컴포넌트를 쓴다.
//
// 제목·요약을 싣지 않는 이유: 리서처 자유 입력이라 "비트코인 4분기 전망" 같은 제목
// 하나로 마스킹이 통째로 무력화된다. 검수로 막는 대신 표시 자체를 없앴다.
//
// 배치 (2026-08-08 확정) — 위는 예측의 내용, 아래는 사는 조건:
//   자산군 칩 → 사람(아바타·이름·인증·등급·실적) → 확신 3종(유리 상자) →
//   하단 좌 검증 시한 / 하단 우 가격·환불 조건
//
// **방향 문구는 싣지 않는다.** 배경 궤적이 이미 방향을 말하므로 글자로 반복하면
// 같은 정보가 두 번 자리를 차지한다. 자산군 글자에 방향색도 입히지 않는다 —
// "국내주식"이 빨간 글씨면 자산군이 나쁘다는 뜻으로 읽힌다.
//
// 배경의 45° 궤적이 이 카드의 signature다. 브랜드 정체성이 45° 축인데(brand README),
// 예측 카드가 파는 것도 결국 '방향'이라 둘을 같은 것으로 만들었다. 장식용 스파크라인이
// 아니라 기울기 자체가 데이터다 — 색이 아니라 모양으로 상승·하락이 읽히므로
// 색각 이상에서도, 흑백 인쇄에서도 방향이 남는다.
//
// **궤적은 종목이 가려진 화면에서만 쓴다.** 차트 모양의 배경은 "이 리포트 종목의 실제
// 차트"로 오인될 여지가 있는데, 종목명·티커가 함께 보이면 그 오인이 특정 종목에 대한
// 시세 표시가 되어버린다. 이 컴포넌트가 구매 전 전용인 것이 곧 그 방어선이다 —
// 구매 후 리포트 상세·판정 완료 카드처럼 종목이 공개되는 화면에는 절대 옮기지 말 것.
// 눈에 보이는 안내는 TraceNotice가 화면마다 한 번씩 맡는다.

export interface MaskedCardData {
  assetClass: string | null;
  direction: string | null;
  profitability: ProfitabilityLevel | null;
  /** 종목 변동성 5구간 — 시스템 산정 (domain/stability.ts), σ 미상이면 null */
  stability: StabilityLevel | null;
  confidence: number | null;
  /**
   * 지금 결제가 막히는 상태 — "지금 살 수 있는" 목록에서는 아예 빠지고,
   * 검색·프로필처럼 **찾아 들어온 자리**에서만 이 표시로 남는다.
   * 가역이라 시세가 돌아오면 저절로 풀린다 (domain/quoteWatch.ts).
   */
  purchaseSuspended?: boolean;
}

export interface MaskedCardFull extends MaskedCardData {
  researcherName: string;
  tier: string;
  careerBadge: string | null;
  hitRate: number | null;
  /** 판정 완료 표본 수 — 적중률은 표본과 함께 읽어야 뜻이 산다 */
  judgedCount: number;
  repurchaseRate: number | null;
  priceKrw: number;
  prepaymentRatio?: number;
  deadline: Date | null;
  /** 게시일 — 배경 궤적의 '기간'을 리서처가 설정한 검증 기간으로 잡는다 */
  publishedAt?: Date | null;
}

/** 자산군 이름만 — 배경 궤적이 방향을 말하는 자리(카드)에서 쓴다 */
export function assetLabel(assetClass: string | null): string {
  if (!assetClass) return "";
  return ASSET_CLASS_LABEL[assetClass as AssetClass] ?? assetClass;
}

/**
 * 자산군 · 방향 — 카드의 제목 자리를 대신한다.
 * 배경 궤적이 없는 자리(리포트 상세 제목, 순위표 행)에서만 쓴다.
 * 예측 카드 본체는 방향을 그림으로 말하므로 assetLabel만 쓴다.
 */
export function maskedHeadline(c: {
  assetClass: string | null;
  direction: string | null;
}): string {
  return [assetLabel(c.assetClass), directionLabel(c.direction)].filter(Boolean).join(" ");
}

/**
 * 배경 궤적 — 예측의 세 축(방향·크기·기간)을 그림 하나로 옮긴다.
 * 좌표 규칙과 그 근거는 directionTrace.ts에 있고 테스트로 고정돼 있다.
 */
function DirectionTrace({
  direction,
  profitability,
  period,
}: {
  direction: string | null;
  profitability: ProfitabilityLevel | null;
  period: PeriodBucket;
}) {
  const input = { up: direction !== "DOWN", profitability, period };
  const tone = input.up ? "var(--pos)" : "var(--neg)";
  return (
    <svg
      className={styles.trace}
      viewBox={`0 0 ${TRACE_VIEWBOX.width} ${TRACE_VIEWBOX.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {/* 면 채움 20% — 확신 상자가 유리로 읽히려면 굴절시킬 바닥이 있어야 한다.
          7%로는 흰 바탕과 구별되지 않아 상자가 사라진다. 덤으로 방향이 곁눈질로 읽힌다 */}
      <path d={traceArea(input)} fill={`color-mix(in srgb, ${tone} 20%, transparent)`} />
      <path
        d={traceLine(input)}
        fill="none"
        stroke={`color-mix(in srgb, ${tone} 34%, transparent)`}
        strokeWidth="1.5"
        strokeLinejoin={traceLineJoin(period)}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/**
 * 실적 — 적중률에 **표본 수를 반드시 붙인다**.
 * 100%(1건)과 62%(47건)이 같은 자리에 같은 크기로 뜨면 오해가 아니라 오도다.
 */
function TrackRecord({ c }: { c: MaskedCardFull }) {
  // 표본이 얇으면 숫자 대신 진행도 — "100% (1건)"은 아무도 안 믿는 숫자이면서
  // 어뷰저에게는 캡처할 만한 한 줄이다 (domain/trackRecord.hitRateLabel)
  if (!showsHitRate(c.hitRate, c.judgedCount)) {
    return (
      <span className={styles.record}>{hitRateLabel(c.hitRate, c.judgedCount)}</span>
    );
  }
  return (
    <span className={styles.record}>
      적중 <strong>{hitRateLabel(c.hitRate, c.judgedCount, { digits: 0 })}</strong>
      <span className={styles.sample}>{c.judgedCount}건</span>
    </span>
  );
}

/** 별 3종 — 서로 다른 축: 수익성(맞으면 얼마나, 5구간 정수) · 안정성(가는 길이 얼마나
    출렁이나 — **종목 변동성으로 시스템이 매긴다**, 자기 신고 아님) · 신뢰도(얼마나 맞을
    것 같나 — 신고한 적중 확률, 별 한 칸이 승산 ×1.73). 자기 신고 안정성 다이얼은 v4에서
    폐지됐고(공짜 마케팅 칸),
    지금 안정성은 리서처가 조작할 수 없는 실측값이라 그 문제가 없다 (domain/stability.ts) */
const RATINGS = [
  { key: "수익성", of: (c: MaskedCardData) => c.profitability },
  { key: "안정성", of: (c: MaskedCardData) => c.stability },
  {
    key: "신뢰도",
    of: (c: MaskedCardData) => (c.confidence === null ? null : confidenceStars(c.confidence)),
  },
] as const;

/** 모든 화면 공용 예측 카드. compact은 가로 레일(좁은 폭)용 */
export function MaskedCard({
  c,
  now,
  href,
  compact = false,
  owned = false,
  footer,
}: {
  c: MaskedCardFull;
  now: Date;
  href?: string;
  compact?: boolean;
  /**
   * 이미 산 카드 — 목록에서 **다른 카드가 된다** (파는 물건 → 내 물건).
   * 가장 강한 신호는 배지가 아니라 **하단 우측이 값에서 행동으로 바뀌는 것**이다:
   * 이미 낸 돈은 더 이상 결정에 쓰이지 않으므로 그 자리에 "본문 열기"가 온다.
   */
  owned?: boolean;
  /** 카드지갑 빼기 버튼처럼 카드마다 다른 조작 */
  footer?: React.ReactNode;
}) {
  // 리서처가 설정한 검증 기간 → 기간 구간(단기성·장기성).
  // 게시일을 모르면 남은 기간으로 대신한다
  const horizonDays = c.deadline
    ? Math.max(
        0,
        (c.deadline.getTime() - (c.publishedAt?.getTime() ?? now.getTime())) / 86_400_000,
      )
    : 30;
  const period = periodBucketOf(horizonDays);

  const body = (
    <>
      <DirectionTrace
        direction={c.direction}
        profitability={c.profitability}
        period={period}
      />

      <span className={styles.chipRow}>
        <span className={styles.assetChip}>{assetLabel(c.assetClass)}</span>
        {/* 결제가 막힌 상태 — 왜 못 사는지 여기서 말하지 않으면, 눌러서 거절당해야 안다.
            "마감"이 아니라 "중단"인 것이 중요하다: 시세가 돌아오면 다시 팔린다 */}
        {c.purchaseSuspended && !owned && (
          <span className={styles.suspendedChip} title="목표까지 남은 폭이 광고 폭의 절반 밑입니다">
            일시 중단
          </span>
        )}
        {/* 소유 표시는 무채색 잉크 — 민트는 플랫폼 검증 전용이라(브랜드 §4-3)
            "내가 샀다"는 사실에 쓰면 플랫폼이 보증한 것으로 읽힌다 */}
        {owned && (
          <span className={styles.ownedChip}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M5 12.5l4.5 4.5L19 7.5"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            구매함
          </span>
        )}
      </span>

      <div className={styles.who}>
        <span className={styles.avatar}>
          <DefaultAvatar className={styles.avatarImg} />
        </span>
        <span className={styles.whoText}>
          <span className={styles.nameRow}>
            <span className={styles.name}>{c.researcherName}</span>
            {c.careerBadge && <VerifiedBadge />}
          </span>
          <span className={styles.tierRow}>
            <TierChip tier={c.tier} />
            <TrackRecord c={c} />
          </span>
        </span>
      </div>

      {/* 확신 3종 — 유리 상자. 선은 자르고 상자는 묶는다: 층을 늘리지 않으면서
          세 값이 카드에서 가장 또렷한 블록이 된다 */}
      <div className={styles.ratingsBox}>
        {RATINGS.map((r) => {
          const v = r.of(c);
          return (
            <span key={r.key} className={styles.ratingCell}>
              <span className={styles.ratingKey}>{r.key}</span>
              {v === null ? (
                <span className={styles.ratingNone}>—</span>
              ) : (
                <StarRating stars={v} label={r.key} />
              )}
            </span>
          );
        })}
      </div>

      {/* 하단 = 왼쪽은 "언제까지", 오른쪽은 "얼마에".
          이미 산 카드에서는 오른쪽이 값이 아니라 **행동**이 된다 — 낸 돈은 더 이상
          결정에 쓰이지 않으므로 가격 자리에 "본문 열기"가 오는 것이 정직하다.
          배지보다 이쪽이 강한 신호다: 카드가 무엇을 하라고 말하는지가 바뀐다 */}
      <div className={styles.foot}>
        {/* 구매 전 카드가 세는 것은 **판매 마감**이다 — 검증 시한이 아니라.
            판매는 검증 기간의 1/3에 닫히므로 시한 D-day를 보여주면 실제로 살 수 있는
            기간의 3배를 광고하는 셈이 된다. 판정 시점은 구매 후 카드가 센다.
            게시일을 모르는 카드(레거시)는 계산할 수 없어 시한으로 물러선다 */}
        <span className={styles.dday}>
          {c.publishedAt && c.deadline
            ? `판매 ${dday(salesWindowEnd(c.publishedAt, c.deadline), now)}`
            : dday(c.deadline, now)}
        </span>
        <span className={styles.footRight}>
          {owned ? (
            <span className={styles.openBody}>본문 열기 →</span>
          ) : (
            <>
              <span className={styles.price}>{c.priceKrw.toLocaleString()}원</span>
              {c.prepaymentRatio === 0 ? (
                <span className={styles.refund}>틀리면 100% 환불</span>
              ) : (
                c.prepaymentRatio !== undefined && (
                  <span className={styles.prepay}>선결제 {c.prepaymentRatio}%</span>
                )
              )}
            </>
          )}
        </span>
      </div>
      {footer}
    </>
  );

  const cls = `${styles.card} ${compact ? styles.compact : ""} ${owned ? styles.owned : ""}`;
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
