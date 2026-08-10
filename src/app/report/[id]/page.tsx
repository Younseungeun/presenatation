import Link from "next/link";
import { notFound } from "next/navigation";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { RISK_LEVEL_LABEL, RISK_LEVEL_NOTE, type RiskLevel } from "@/domain/instrumentRisk";
import { cardProfitabilityLevel } from "@/domain/profitability";
import { isSalesWindowOpen, salesGuaranteeText } from "@/domain/salesWindow";
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
import { confidenceStars, stabilityStars, StarRating } from "../../StarRating";
import { StatusChip, type StatusKind } from "../../StatusChip";
import { JudgmentReceipt } from "./JudgmentReceipt";
import { PurchaseButton } from "./PurchaseButton";
import { RevealedCard } from "./RevealedCard";
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

  // 마스킹 상태의 표에서만 쓴다 — 열린 뒤의 방향·크기는 RevealedCard가 맡는다
  const dir = card?.direction === "UP" ? "▲ 상승 (buy)" : "▼ 하락 (sell)";

  // 구매 전 마스킹 — 종목·목표 수익률이 곧 상품이라, 사기 전에는
  // 자산군·방향·수익성(자동 산출 5구간)·시한·신뢰도·안정성까지만 보여준다.
  // 판정이 끝난 카드는 상품 가치가 소진된 공개 기록이므로 전부 공개하고,
  // 리서처 본인에게도 가리지 않는다.
  const isOwner = viewerId !== null && report.researcher.user.id === viewerId;
  const masked = !!card && !purchased && !judgment && !isOwner;
  const profitabilityLevel = card ? cardProfitabilityLevel(card) : null;
  const now = new Date();

  // 지금 실제로 살 수 있나 — **결제 관문(assertPurchasable)과 같은 기준으로 판단한다.**
  // 저장된 salesClosedAt만 보면 화면이 서버보다 헐거워진다: 판매 기간이 끝났는데
  // 배치가 아직 기록 전이면 구매 버튼이 그대로 떠 있고, 눌러야 에러를 만난다.
  // 화면이 "살 수 있다"고 말한 것은 서버도 그렇게 답해야 한다
  const sellable =
    !report.salesClosedAt &&
    !judgment &&
    (!card || card.deadline > now) &&
    isSalesWindowOpen(report.publishedAt, card?.deadline, now);

  // 예측 사양표 — **구매 여부에 따라 위치가 달라지므로** 변수로 뽑아 둔다.
  //
  //   구매 전: 히어로 카드 → **사양표** → 잠긴 본문
  //     아직 안 산 사람에게 이 표는 결정의 재료다. 본문이 잠겨 있으니 살지 말지를
  //     판단할 것이 시한·확신 3종·선결제뿐이라 위에 있어야 한다.
  //
  //   구매 후: 히어로 카드 → **본문** → 사양표 → 구매 정보
  //     사고 나면 표의 값은 이미 결정에 쓰이지 않는다. 돈을 낸 이유는 본문을 읽으려는
  //     것인데 표 두 개를 지나야 글이 나오면, 매번 아는 값을 스크롤로 넘겨야 한다.
  //     표는 사라지지 않고 참고 자료로 글 뒤에 남는다 (판정 조건 확인용).
  const specBox = card && (
    <div className={styles.cardBox}>
      {/* 자산·방향은 마스킹 상태에서만 표에 남는다 — 열린 뒤에는 위 카드가 맡는다 */}
      {masked && (
        <>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>자산</span>
            <span className={styles.cardVal}>
              {`${ASSET_CLASS_LABEL[card.assetClass as AssetClass]} (종목은 구매 후 공개)`}
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>방향</span>
            <span className={styles.cardVal}>{dir}</span>
          </div>
        </>
      )}
      <div className={styles.cardRow}>
        <span className={styles.cardKey}>검증 시한</span>
        <span className={styles.cardVal}>
          {new Date(card.deadline).toLocaleString("ko-KR")}
        </span>
      </div>
      <div className={styles.cardRow}>
        <span className={styles.cardKey}>신뢰도</span>
        <span className={styles.cardVal}>
          <StarRating stars={confidenceStars(card.confidence)} label="신뢰도" />
        </span>
      </div>
      <div className={styles.cardRow}>
        <span className={styles.cardKey}>안정성</span>
        <span className={styles.cardVal}>
          <StarRating stars={stabilityStars(card.selfStability)} label="안정성" />
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
      {/* 별점 읽는 법 — 구매자의 알 권리. 별은 다이얼 원값(1~10)이 아니라 그 신고가
          함의하는 최소 승률 × 5다. 이 규칙을 모르면 별 4개를 "만점의 8할"로 읽는다 */}
      <p className={styles.cardFootnote}>
        신뢰도·안정성 별점은 리서처 신고값이 함의하는 최소 승률입니다 (별 4개 = 80%,
        별 5개 = 승률 100%라 존재하지 않음).{" "}
        <Link href="/score" className={styles.cardFootnoteLink}>
          산정 방식 직접 계산해 보기 →
        </Link>
      </p>
      {/* 판매 중 보장 고지 — 실제로 집행되는 규칙(잔여 < 구간 바닥×2/3 종가 → 자동 마감)을
          구매자 언어로. **공개 정보(구간)에서만 유도한다** — 실제 잔여 수치를 적으면
          시세와 대조해 종목이 역산된다. 고지는 보장선까지, 집행이 그 말을 참으로 만든다 */}
      {masked && profitabilityLevel !== null && (
        <p className={styles.cardFootnote}>
          {salesGuaranteeText(card.assetClass as AssetClass, profitabilityLevel)}
        </p>
      )}
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
  );

  // 판정 근거 영수증 — 사양표와 한 덩어리로 움직인다 (둘 다 "이 예측이 무엇이었나")
  const receipt = card && judgment && <JudgmentReceipt card={card} judgment={judgment} />;

  return (
    <>
      {/* 무료 글은 홈에서 들어오므로 홈으로 나간다. 리서처 프로필로 강제로 내보내면
          "글이 마음에 들어 사람을 보러 가는" 판단을 앱이 대신해 버린다 —
          그 선택은 본문 끝의 명함을 눌러 본인이 한다.
          유료 리포트는 리서처 프로필이 실제 상위 화면이라 그대로 둔다 */}
      <AppHeader
        title="리포트"
        titleAs="span"
        backHref={free ? "/" : `/r/${report.researcherId}`}
      />
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

      {/* 구매로 열린 카드 — 종목·방향·목표가가 히어로.
          마스킹이 풀린 상태(구매자·리서처 본인·판정 완료·운영자)에서만 그린다.
          표에 값만 채우면 방금 돈 내고 얻은 것이 선결제 비율과 같은 무게로 나열된다 */}
      {card && !masked && <RevealedCard card={card} now={now} />}

      {/* 구매 전에는 사양표가 결정의 재료라 본문(잠김) 앞에 온다.
          구매 후에는 본문 뒤로 내려간다 — 아래 purchased 분기에서 그린다 */}
      {!purchased && specBox}
      {!purchased && receipt}

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

          {/* **본문이 먼저다.** 돈을 낸 이유가 이 글이다. 사양표·구매 정보는 사고 나면
              더 이상 결정에 쓰이지 않는 값이라, 그 둘을 앞에 두면 매번 아는 것을
              스크롤로 넘긴 뒤에야 글이 나온다 */}
          <div className={styles.section}>리포트 본문</div>
          <div className={styles.content}>{report.content}</div>
          {purchase?.settlement && (
            <p className={styles.sub}>
              {purchase.settlement.buyerRefundKrw > 0
                ? `이 예측은 성과 조건을 충족하지 못해 ${purchase.settlement.buyerRefundKrw.toLocaleString()}원이 현금 환불됩니다.`
                : "이 예측은 적중해 정상 정산되었습니다."}
            </p>
          )}

          {/* 사양표는 사라지지 않고 판정 조건 참고 자료로 글 뒤에 남는다 */}
          {specBox}
          {receipt}

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
        </>
      ) : report.status === "PUBLISHED" && !sellable ? (
        // 판매 마감 — 공개 문구는 사유 무관 이 한 줄로 통일한다. 사유("목표 접근" 등)를
        // 공개하면 자산군·방향·구간·시각과 조합해 종목이 좁혀진다(마스킹 붕괴).
        // 상세 사유는 리서처 본인 알림으로만 간다
        <div className={styles.locked}>
          판매가 마감된 리포트입니다. 카드는 그대로 검증되어 시한에 자동 판정됩니다.
        </div>
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
