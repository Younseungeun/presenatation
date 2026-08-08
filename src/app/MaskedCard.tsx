import Link from "next/link";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import type { ProfitabilityLevel } from "@/domain/profitability";
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
import { dday, directionLabel } from "./format";
import { StarRating, tenScaleToStars } from "./StarRating";
import { TierChip } from "./TierChip";
import styles from "./maskedCard.module.css";

// 구매 전 예측 카드 — 목록·레일·프로필·장바구니 전부 이 한 컴포넌트를 쓴다.
//
// 제목·요약을 싣지 않는 이유: 리서처 자유 입력이라 "비트코인 4분기 전망" 같은 제목
// 하나로 마스킹이 통째로 무력화된다. 검수로 막는 대신 표시 자체를 없앴다.
//
// 배치 (좌: 사람 / 우: 예측):
//   좌상단 자산군·방향 + 우상단 D-day → 좌측 아바타·적중률·재구매율 →
//   우측 이름+인증배지·등급 → 별점 3종 → 하단 가격·선결제·환불 조건
// 왼쪽은 "누구를 믿을 것인가", 오른쪽은 "무엇을 얼마나 확신하는가"로 축이 갈린다.
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
  confidence: number | null;
  stability: number | null;
}

export interface MaskedCardFull extends MaskedCardData {
  researcherName: string;
  tier: string;
  careerBadge: string | null;
  hitRate: number | null;
  repurchaseRate: number | null;
  priceKrw: number;
  prepaymentRatio?: number;
  deadline: Date | null;
  /** 게시일 — 배경 궤적의 '기간'을 리서처가 설정한 검증 기간으로 잡는다 */
  publishedAt?: Date | null;
}

/** 자산군 · 방향 — 카드의 제목 자리를 대신한다 */
export function maskedHeadline(c: {
  assetClass: string | null;
  direction: string | null;
}): string {
  const asset = c.assetClass
    ? (ASSET_CLASS_LABEL[c.assetClass as AssetClass] ?? c.assetClass)
    : "";
  return [asset, directionLabel(c.direction)].filter(Boolean).join(" ");
}

/** 자기 평가 3종을 별 5개로 (신뢰도·안정성은 1~10이라 반 개 단위, 수익성은 5구간이라 정수) */
export function SelfRatings({ c }: { c: MaskedCardData }) {
  return (
    <span className={styles.ratings}>
      {c.profitability !== null && (
        <span className={styles.rating}>
          <span className={styles.ratingKey}>수익성</span>
          <StarRating stars={c.profitability} label="수익성" />
        </span>
      )}
      {c.stability !== null && (
        <span className={styles.rating}>
          <span className={styles.ratingKey}>안정성</span>
          <StarRating stars={tenScaleToStars(c.stability)} label="안정성" />
        </span>
      )}
      {c.confidence !== null && (
        <span className={styles.rating}>
          <span className={styles.ratingKey}>신뢰도</span>
          <StarRating stars={tenScaleToStars(c.confidence)} label="신뢰도" />
        </span>
      )}
    </span>
  );
}

/** 자산군 · 방향을 방향색으로 — 한 줄로 쓸 때 */
export function MaskedHeadline({ c }: { c: MaskedCardData }) {
  return (
    <span
      className={styles.headline}
      style={{ color: c.direction === "UP" ? "var(--pos)" : "var(--neg)" }}
    >
      {maskedHeadline(c)}
    </span>
  );
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
      <path d={traceArea(input)} fill={`color-mix(in srgb, ${tone} 7%, transparent)`} />
      <path
        d={traceLine(input)}
        fill="none"
        stroke={`color-mix(in srgb, ${tone} 30%, transparent)`}
        strokeWidth="1.5"
        strokeLinejoin={traceLineJoin(period)}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function pct(v: number | null): string {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

/** 모든 화면 공용 예측 카드. compact은 가로 레일(좁은 폭)용 */
export function MaskedCard({
  c,
  now,
  href,
  compact = false,
  footer,
}: {
  c: MaskedCardFull;
  now: Date;
  href?: string;
  compact?: boolean;
  /** 장바구니 삭제 버튼처럼 카드마다 다른 조작 */
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
      {/* 궤적은 이 영역(가격 줄 위)까지만 흐른다 — 배치 기준이 .main이라
          별점이 줄바꿈돼 높이가 달라져도 가격 줄을 침범하지 않는다 */}
      <div className={styles.main}>
        <DirectionTrace
          direction={c.direction}
          profitability={c.profitability}
          period={period}
        />

        <div className={styles.top}>
          <span
            className={styles.asset}
            style={{ color: c.direction === "UP" ? "var(--pos)" : "var(--neg)" }}
          >
            {maskedHeadline(c)}
          </span>
          <span className={styles.dday}>{dday(c.deadline, now)}</span>
        </div>

        <div className={styles.body}>
          <div className={styles.left}>
            <span className={styles.avatar}>
              <DefaultAvatar className={styles.avatarImg} />
            </span>
            <span className={styles.stat}>
              <strong>{pct(c.hitRate)}</strong>적중률
            </span>
            <span className={styles.stat}>
              <strong>{pct(c.repurchaseRate)}</strong>재구매율
            </span>
          </div>

          <div className={styles.right}>
            <span className={styles.nameRow}>
              <span className={styles.name}>{c.researcherName}</span>
              {c.careerBadge && <VerifiedBadge />}
              <TierChip tier={c.tier} />
            </span>
            <SelfRatings c={c} />
          </div>
        </div>
      </div>

      <div className={styles.foot}>
        <span className={styles.price}>{c.priceKrw.toLocaleString()}원</span>
        {c.prepaymentRatio !== undefined && (
          <span className={styles.prepay}>선결제 {c.prepaymentRatio}%</span>
        )}
        {c.prepaymentRatio === 0 && <span className={styles.refund}>틀리면 100% 환불</span>}
      </div>
      {footer}
    </>
  );

  const cls = `${styles.card} ${compact ? styles.compact : ""}`;
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
