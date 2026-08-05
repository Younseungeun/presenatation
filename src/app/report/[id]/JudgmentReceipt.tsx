import type { Judgment, PredictionCard } from "@prisma/client";
import styles from "../../market.module.css";

// 판정 근거 영수증 — "사람이 아니라 시장이 채점했다"는 물증.
// 판정 파이프라인이 저장해 둔 값(기준가·판정 가격·실현 등락·데이터 소스·감사 스냅샷)을
// 기준가 → 판정 가격 → 실현 등락 → 결과의 사슬로 펼쳐 보여준다.
// 새 데이터는 없다 — 이미 기록된 감사 값의 노출이며, 분쟁 시 재현 가능함을 함께 알린다.

const BASE_MODE_LABEL: Record<string, string> = {
  FIXED_AT_PUBLISH: "게시 시점 확정",
  PREV_CLOSE_AT_JUDGMENT: "직전 거래일 종가로 소급 확정",
  DAY_CLOSE_AT_JUDGMENT: "게시일 종가로 소급 확정",
};

const UNDECIDABLE_LABEL: Record<string, string> = {
  TRADING_HALT: "거래정지",
  DELISTED: "상장폐지",
  AMBIGUOUS: "조건 모호",
  WITHDRAWN: "카드 철회",
};

/** 데이터 소스 식별자 → 표시명 (식별자는 어댑터별 sourceId 문자열) */
function sourceLabel(dataSource: string | null): string {
  const s = (dataSource ?? "").toLowerCase();
  if (s.includes("upbit")) return "업비트";
  if (s.includes("fsc") || s.includes("data.go")) return "금융위 공공데이터포털";
  if (s.includes("twelve")) return "Twelve Data";
  if (s.includes("stooq")) return "Stooq";
  if (s.includes("manual")) return "운영자 검증 시세";
  if (s.includes("fixture")) return "개발용 픽스처";
  return dataSource ?? "—";
}

function fmtPrice(v: number, currency: string): string {
  return currency === "USD" ? `$${v.toLocaleString()}` : `${v.toLocaleString()}원`;
}

function fmtDateTime(d: Date): string {
  return new Date(d).toLocaleString("ko-KR", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function JudgmentReceipt({
  card,
  judgment,
}: {
  card: PredictionCard;
  judgment: Judgment;
}) {
  // 스냅샷에서 시세 수집 시각만 꺼낸다 (원문은 분쟁 대비 보관용)
  let fetchedAt: string | null = null;
  try {
    const audit: unknown = JSON.parse(judgment.marketSnapshotJson ?? "");
    if (audit && typeof audit === "object" && "fetchedAt" in audit) {
      fetchedAt = String((audit as { fetchedAt: unknown }).fetchedAt);
    }
  } catch {
    // 스냅샷이 없거나 형식이 다르면 수집 시각 표기만 생략한다
  }

  const dirSign = card.direction === "UP" ? "▲" : "▼";
  const target =
    card.targetType === "RETURN_PCT"
      ? `${dirSign} ${card.targetValue}%`
      : `목표가 ${fmtPrice(card.targetValue, card.currency)}`;

  if (judgment.outcome === "UNDECIDABLE") {
    return (
      <>
        <div className={styles.section}>판정 근거</div>
        <div className={styles.receipt}>
          <div className={styles.receiptRow}>
            <span className={styles.receiptKey}>판정 결과</span>
            <span className={styles.receiptVal}>
              판정 불가
              {judgment.undecidableReason &&
                ` · ${UNDECIDABLE_LABEL[judgment.undecidableReason] ?? judgment.undecidableReason}`}
            </span>
          </div>
          <p className={styles.receiptFoot}>
            자동 판정이 불가능한 사유가 확인되어 무효 처리되었습니다. 결제액은 전액 현금
            환불되며 수수료는 발생하지 않습니다. 판정 {fmtDateTime(judgment.judgedAt)}.
          </p>
        </div>
      </>
    );
  }

  const hit = judgment.outcome === "HIT";
  const realized = judgment.realizedReturnPct;

  return (
    <>
      <div className={styles.section}>판정 근거</div>
      <div className={styles.receipt}>
        <div className={styles.receiptRow}>
          <span className={styles.receiptKey}>기준가</span>
          <span className={styles.receiptVal}>
            {card.basePrice != null ? fmtPrice(card.basePrice, card.currency) : "—"}
            <small> {BASE_MODE_LABEL[card.baseMode ?? ""] ?? ""}</small>
          </span>
        </div>
        <div className={styles.receiptRow}>
          <span className={styles.receiptKey}>판정 가격</span>
          <span className={styles.receiptVal}>
            {judgment.settledPrice != null
              ? fmtPrice(judgment.settledPrice, card.currency)
              : "—"}
            <small> 시한 도래 시 시장가</small>
          </span>
        </div>
        <div className={styles.receiptRow}>
          <span className={styles.receiptKey}>실현 등락</span>
          <span className={styles.receiptVal}>
            {realized != null ? `${realized >= 0 ? "+" : ""}${realized.toFixed(1)}%` : "—"}
            <small> 예측 {target}</small>
          </span>
        </div>
        <div className={`${styles.receiptRow} ${styles.receiptResult}`}>
          <span className={styles.receiptKey}>결과</span>
          <span className={hit ? styles.receiptHit : styles.receiptMiss}>
            {hit ? "적중" : "실패"}
            <small>
              {" "}
              — 예측 방향{hit ? "과 일치" : "과 불일치"}, 위 수치로 자동 판정
            </small>
          </span>
        </div>
        <p className={styles.receiptFoot}>
          시세 출처 {sourceLabel(judgment.dataSource)}
          {fetchedAt && ` · 수집 ${fmtDateTime(new Date(fetchedAt))}`} · 판정{" "}
          {fmtDateTime(judgment.judgedAt)}. 판정에 사용된 원천 시세 스냅샷은 그대로
          보관되어 분쟁 시 동일하게 재현할 수 있습니다.
        </p>
      </div>
    </>
  );
}
