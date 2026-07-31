import Link from "next/link";
import { notFound } from "next/navigation";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { RISK_LEVEL_LABEL, RISK_LEVEL_NOTE, type RiskLevel } from "@/domain/instrumentRisk";
import { prisma } from "@/server/db";
import { getReportDetail } from "@/server/leaderboardQueries";
import { getSessionUserId } from "@/server/session";
import { Disclaimer } from "../../Disclaimer";
import { PurchaseButton } from "./PurchaseButton";
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

  const dir = card?.direction === "UP" ? "▲ 상승 (buy)" : "▼ 하락 (sell)";
  const size =
    card?.targetType === "RETURN_PCT"
      ? `${card.targetValue}%`
      : `목표가 ${card?.targetValue.toLocaleString()}`;

  return (
    <main className={styles.page}>
      <Link href={`/r/${report.researcherId}`} className={styles.backLink}>
        ← {researcherName}
      </Link>
      <h1 className={styles.h1} style={{ marginTop: 12 }}>
        {report.title}
      </h1>
      <p className={styles.sub}>{report.summary}</p>

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
                {judgment.outcome === "HIT"
                  ? "적중"
                  : judgment.outcome === "MISS"
                    ? "실패"
                    : "판정 불가"}
                {judgment.realizedReturnPct != null &&
                  ` (실현 ${judgment.realizedReturnPct >= 0 ? "+" : ""}${judgment.realizedReturnPct.toFixed(1)}%)`}
              </span>
            </div>
          )}
        </div>
      )}

      {purchased ? (
        <>
          <div className={styles.section}>리포트 본문</div>
          {!purchase && (
            <p className={styles.sub}>운영자 권한으로 검토를 위해 본문을 열람 중입니다.</p>
          )}
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
        </>
      ) : (
        <div className={styles.locked}>현재 판매 중인 리포트가 아닙니다.</div>
      )}

      <Disclaimer />
    </main>
  );
}
