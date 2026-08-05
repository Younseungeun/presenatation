import { notFound } from "next/navigation";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { prisma } from "@/server/db";
import { getReportDetail } from "@/server/leaderboardQueries";
import { PAYMENT_METHOD_LABEL, type PaymentMethod } from "@/server/purchaseService";
import { isFreeReport } from "@/server/freeReportService";
import { getSessionUserId } from "@/server/session";
import { TOSS_CLIENT_KEY } from "@/server/tossPayments";
import { AppHeader } from "../../AppHeader";
import { Disclaimer } from "../../Disclaimer";
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

  const { report, purchase } = data;
  const card = report.predictionCard;
  const judgment = card?.judgment;
  const researcherName = report.researcher.user.penName ?? report.researcher.user.email;
  const purchased = !!purchase;
  // 무료 글은 예측 카드가 없어 결제·판정 흐름을 타지 않는다
  const free = isFreeReport(report);

  const fmtDateTime = (d: Date) =>
    new Date(d).toLocaleString("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

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

  return (
    <>
      <AppHeader title="리포트" titleAs="span" backHref={`/r/${report.researcherId}`} />
      <main className={styles.page}>
      <h1 className={styles.h1}>{report.title}</h1>
      <p className={styles.sub}>
        {researcherName} · {report.summary}
      </p>

      {card && (
        <div className={styles.cardBox}>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>자산</span>
            <span className={styles.cardVal}>
              {ASSET_CLASS_LABEL[card.assetClass as AssetClass]} {card.assetName} ({card.ticker})
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>방향 · 크기</span>
            <span className={styles.cardVal}>
              {dir} · {size}
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>검증 시한</span>
            <span className={styles.cardVal}>
              {new Date(card.deadline).toLocaleString("ko-KR")}
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>신뢰도 · 안정성 · 수익성</span>
            <span className={styles.cardVal}>
              {card.confidence} · {card.selfStability} · {card.selfProfitability}
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
        </>
      ) : purchased ? (
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

          <div className={styles.section}>리포트 본문</div>
          <div className={styles.content}>{report.content}</div>
          {purchase.settlement && (
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
