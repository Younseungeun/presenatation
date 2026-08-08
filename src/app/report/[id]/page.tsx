import { notFound } from "next/navigation";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { RISK_LEVEL_LABEL, RISK_LEVEL_NOTE, type RiskLevel } from "@/domain/instrumentRisk";
import { cardProfitabilityLevel } from "@/domain/profitability";
import { prisma } from "@/server/db";
import { getReportDetail } from "@/server/leaderboardQueries";
import { getResearcherCallout } from "@/server/marketQueries";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/server/purchaseService";
import { isFreeReport } from "@/server/freeReportService";
import { getSessionUserId } from "@/server/session";
import { TOSS_CLIENT_KEY } from "@/server/tossPayments";
import { AppHeader } from "../../AppHeader";
import { Disclaimer } from "../../Disclaimer";
import { fmtDateTime } from "../../format";
import { maskedHeadline } from "../../MaskedCard";
import { ResearcherCallout } from "../../ResearcherCallout";
import { StarRating, tenScaleToStars } from "../../StarRating";
import { StatusChip, type StatusKind } from "../../StatusChip";
import { JudgmentReceipt } from "./JudgmentReceipt";
import { PurchaseButton } from "./PurchaseButton";
import { TossCheckoutButton } from "./TossCheckoutButton";
import styles from "../../market.module.css";

export const dynamic = "force-dynamic";

export default async function ReportDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const viewerId = await getSessionUserId();
  const data = await getReportDetail(prisma, id, viewerId);
  if (!data) notFound();

  const { report, purchase, instrument } = data;
  const riskLevel = (instrument?.riskLevel ?? "NONE") as RiskLevel;
  const card = report.predictionCard;
  const judgment = card?.judgment;
  const researcherName = report.researcher.user.penName ?? report.researcher.user.email;
  // 운영자는 검토를 위해 본문을 볼 수 있어야 한다 — 게시 보류 건은 본문 판단이 결정의 근거다
  const isOperator = viewerId
    ? (await prisma.user.findUnique({ where: { id: viewerId }, select: { role: true } }))?.role ===
      "OPERATOR"
    : false;
  const purchased = !!purchase || isOperator;
  // 무료 글은 예측 카드가 없어 결제·판정 흐름을 타지 않는다
  const free = isFreeReport(report);
  // 무료 글에만 리서처 명함을 붙인다 — 유료 글은 이미 카드가 그 사람을 말하고 있다
  const callout = free ? await getResearcherCallout(prisma, report.researcherId) : null;

  // 구매 진행 상태 — 에스크로 상태 + 환불 실행 여부를 구매자 언어로.
  // 환불 색은 판정 결과를 따른다 (실패 → 빨강, 판정 불가 → 주황)
  const refundStatus: StatusKind =
    judgment?.outcome === "UNDECIDABLE" ? "UNDECIDABLE" : "MISS";
  const purchaseStatus: { label: string; status: StatusKind } | null = purchase
    ? purchase.escrowStatus === "HELD"
      ? { label: "판정 대기 · 에스크로 보관 중", status: "VERIFYING" }
      : purchase.escrowStatus === "REFUNDED"
        ? purchase.settlement?.refundExecutedAt
          ? { label: "환불 완료", status: refundStatus }
          : { label: "환불 확정 · 지급 준비 중", status: refundStatus }
        : { label: "적중 · 정산 완료", status: "HIT" }
    : null;

  const dir = card?.direction === "UP" ? "▲ 상승 (buy)" : "▼ 하락 (sell)";
  const size =
    card?.targetType === "RETURN_PCT"
      ? `${card.targetValue}%`
      : `목표가 ${card?.targetValue.toLocaleString()}`;

  // 구매 전 마스킹 — 종목·목표 수익률이 곧 상품이라, 사기 전에는
  // 자산군·방향·수익성(자동 산출 5구간)·시한·신뢰도·안정성까지만 보여준다.
  // 판정이 끝난 카드는 상품 가치가 소진된 공개 기록이므로 전부 공개하고,
  // 리서처 본인에게도 가리지 않는다.
  const isOwner = viewerId !== null && report.researcher.user.id === viewerId;
  const masked = !!card && !purchased && !judgment && !isOwner;
  const profitabilityLevel = card ? cardProfitabilityLevel(card) : null;

  return (
    <>
      <AppHeader title="리포트" titleAs="span" backHref={`/r/${report.researcherId}`} />
      <main className={styles.page}>
      {/* 제목·요약도 리서처 자유 입력이라 구매 전에는 감춘다 —
          종목명이 제목에 들어가면 나머지 마스킹이 통째로 무력해진다 */}
      <h1 className={styles.h1}>
        {masked ? `${maskedHeadline(card)} 예측 카드` : report.title}
      </h1>
      <p className={styles.sub}>
        {masked ? `${researcherName} · 제목과 요약은 구매 후 공개됩니다` : `${researcherName} · ${report.summary}`}
      </p>

      {/* 거래소가 위험을 경고한 종목이면 구매 전에 먼저 보여준다 */}
      {riskLevel !== "NONE" && (
        <div
          style={{
            border: "1px solid color-mix(in srgb, var(--neg) 35%, transparent)",
            background: "color-mix(in srgb, var(--neg) 7%, transparent)",
            borderRadius: "var(--radius)",
            padding: "12px 14px",
            margin: "12px 0",
            fontSize: 13.5,
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: "var(--neg)" }}>
            ⚠ {RISK_LEVEL_LABEL[riskLevel]} 종목
          </strong>
          <br />
          {RISK_LEVEL_NOTE[riskLevel]}
          {instrument?.riskNote ? ` (${instrument.riskNote})` : ""}
        </div>
      )}

      {card && (
        <div className={styles.cardBox}>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>자산</span>
            <span className={styles.cardVal}>
              {masked
                ? `${ASSET_CLASS_LABEL[card.assetClass as AssetClass]} (종목은 구매 후 공개)`
                : `${ASSET_CLASS_LABEL[card.assetClass as AssetClass]} ${card.assetName} (${card.ticker})`}
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>{masked ? "방향" : "방향 · 크기"}</span>
            <span className={styles.cardVal}>{masked ? dir : `${dir} · ${size}`}</span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>검증 시한</span>
            <span className={styles.cardVal}>
              {new Date(card.deadline).toLocaleString("ko-KR")}
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>신뢰도</span>
            <span className={styles.cardVal}>
              <StarRating stars={tenScaleToStars(card.confidence)} label="신뢰도" />
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>안정성</span>
            <span className={styles.cardVal}>
              <StarRating stars={tenScaleToStars(card.selfStability)} label="안정성" />
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>수익성</span>
            <span className={styles.cardVal}>
              {profitabilityLevel === null ? (
                "—"
              ) : (
                <StarRating stars={profitabilityLevel} label="수익성" />
              )}
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>선결제</span>
            <span className={styles.cardVal}>
              {report.prepaymentRatio}%{" "}
              {report.prepaymentRatio === 0 && "(틀리면 100% 현금 환불)"}
            </span>
          </div>
          {judgment && (
            <div className={styles.cardRow}>
              <span className={styles.cardKey}>판정 결과</span>
              <span className={styles.cardVal}>
                <StatusChip
                  status={
                    judgment.outcome === "HIT"
                      ? "HIT"
                      : judgment.outcome === "MISS"
                        ? "MISS"
                        : "UNDECIDABLE"
                  }
                />
                {judgment.realizedReturnPct != null &&
                  ` 실현 ${judgment.realizedReturnPct >= 0 ? "+" : ""}${judgment.realizedReturnPct.toFixed(1)}%`}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 판정 근거 영수증 — 기준가→판정 가격→실현 등락→결과. 조작 불가능한 평판의 물증 */}
      {card && judgment && <JudgmentReceipt card={card} judgment={judgment} />}

      {free ? (
        <>
          <div className={styles.section}>리포트 본문</div>
          <div className={styles.content}>{report.content}</div>
          <p className={styles.sub}>
            무료로 공개된 시황 리포트입니다. 예측 카드가 없어 판정·환불 대상이 아닙니다.
          </p>
          {/* 글을 끝까지 읽은 직후가 신뢰가 가장 높은 순간 — 전환은 여기서 일어난다.
              실적이 없는 신규 리서처에게는 이 글이 트랙레코드를 대신하는 증명이다 */}
          {callout && <ResearcherCallout data={callout} />}
        </>
      ) : purchased ? (
        <>
          {!purchase && (
            <p className={styles.sub}>운영자 권한으로 검토를 위해 본문을 열람 중입니다.</p>
          )}
          {/* 운영자는 구매 없이도 본문을 보므로 구매 정보 블록은 실제 구매자에게만 */}
          {purchase && (
          <>
          <div className={styles.section}>구매 정보</div>
          <div className={styles.cardBox}>
            <div className={styles.cardRow}>
              <span className={styles.cardKey}>결제 일시</span>
              <span className={styles.cardVal}>{fmtDateTime(purchase.paidAt)}</span>
            </div>
            <div className={styles.cardRow}>
              <span className={styles.cardKey}>결제 금액</span>
              <span className={styles.cardVal}>{purchase.amountKrw.toLocaleString()}원</span>
            </div>
            <div className={styles.cardRow}>
              <span className={styles.cardKey}>결제 수단</span>
              <span className={styles.cardVal}>
                {PAYMENT_METHOD_LABEL[purchase.paymentMethod as PaymentMethod] ??
                  purchase.paymentMethod}
                {purchase.paymentInfo && (
                  <>
                    <br />
                    <small style={{ fontWeight: 500, color: "var(--text-weak)" }}>
                      {purchase.paymentInfo}
                    </small>
                  </>
                )}
              </span>
            </div>
            <div className={styles.cardRow}>
              <span className={styles.cardKey}>진행 상태</span>
              <span className={styles.cardVal}>
                <StatusChip status={purchaseStatus!.status} label={purchaseStatus!.label} />
              </span>
            </div>
            {purchase.settlement && (
              <div className={styles.cardRow}>
                <span className={styles.cardKey}>판정 일시</span>
                <span className={styles.cardVal}>
                  {fmtDateTime(purchase.settlement.settledAt)}
                </span>
              </div>
            )}
            {purchase.settlement && purchase.settlement.buyerRefundKrw > 0 && (
              <div className={styles.cardRow}>
                <span className={styles.cardKey}>환불 금액</span>
                <span className={styles.cardVal}>
                  {purchase.settlement.buyerRefundKrw.toLocaleString()}원
                  {purchase.settlement.refundExecutedAt
                    ? ` (${fmtDateTime(purchase.settlement.refundExecutedAt)} 실행)`
                    : " (PG 취소·계좌이체로 지급 예정)"}
                </span>
              </div>
            )}
          </div>
          </>
          )}

          <div className={styles.section}>리포트 본문</div>
          <div className={styles.content}>{report.content}</div>
          {purchase?.settlement && (
            <p className={styles.sub}>
              {purchase.settlement.buyerRefundKrw > 0
                ? `이 예측은 성과 조건을 충족하지 못해 ${purchase.settlement.buyerRefundKrw.toLocaleString()}원이 현금 환불됩니다.`
                : "이 예측은 적중해 정상 정산되었습니다."}
            </p>
          )}
        </>
      ) : report.status === "PUBLISHED" ? (
        <>
          <div className={styles.locked}>
            본문은 결제 후 열람할 수 있습니다. 예측이 틀리면 성과 연동분은 현금으로
            환불됩니다.
          </div>
          <PurchaseButton
            reportId={report.id}
            priceKrw={report.priceKrw}
            hasIdentity={!!viewerId}
          />
          {viewerId && (
            <TossCheckoutButton reportId={report.id} clientKey={TOSS_CLIENT_KEY} buyerId={viewerId} />
          )}
        </>
      ) : (
        <div className={styles.locked}>현재 판매 중인 리포트가 아닙니다.</div>
      )}

      <Disclaimer />
      </main>
    </>
  );
}
