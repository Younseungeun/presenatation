import Link from "next/link";
import { notFound } from "next/navigation";
import { ASSET_CLASS_LABEL, type AssetClass, type Direction } from "@/domain/constants";
import { RISK_LEVEL_LABEL, RISK_LEVEL_NOTE, type RiskLevel } from "@/domain/instrumentRisk";
import { cardProfitabilityLevel } from "@/domain/profitability";
import { cardStabilityLevel } from "@/domain/stability";
import {
  isSalesWindowOpen,
  remainingFraction,
  salesGuaranteeText,
  salesNoticeState,
  type SalesNoticeState,
} from "@/domain/salesWindow";
import { prisma } from "@/server/db";
import { isJudgmentPaused } from "@/server/judgmentPause";
import { JUDGMENT_ABSOLUTE_CAP_DAYS } from "@/server/judgmentBatch";
import { getReportDetail } from "@/server/leaderboardQueries";
import { ABUSE_SUSPENDED_MESSAGE } from "@/domain/abuseSuspension";
import { isAbuseSuspended } from "@/server/abuseReportService";
import { getResearcherCallout } from "@/server/marketQueries";
import { PAYMENT_METHOD_LABEL } from "@/server/purchaseService";
import { researcherConfidenceCap } from "@/server/scoreService";
import {
  claimedProbability,
  magnitudePctToTargetPrice,
  noSkillTouchProbability,
  SCORE_MODEL_NAME,
} from "@/domain/scoring";
import { fetchCachedPrice } from "@/server/priceCache";
import { isFreeReport } from "@/server/freeReportService";
import { getSessionUserId } from "@/server/session";
import { TOSS_CLIENT_KEY } from "@/server/tossPayments";
import { AppHeader } from "../../AppHeader";
import { Disclaimer } from "../../Disclaimer";
import { fmtDateTime } from "@/lib/format";
import { maskedHeadline } from "../../MaskedCard";
import { ResearcherCallout } from "../../ResearcherCallout";
import { ReportAbuseLink } from "./ReportAbuseLink";
import { confidenceStars, StarRating } from "../../StarRating";
import { StatusChip, type StatusKind } from "../../StatusChip";
import { JudgmentReceipt } from "./JudgmentReceipt";
import { DisputeForm } from "./DisputeForm";

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

  const { report, purchase, instrument, disputable } = data;
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
  // **"보내는 중"이 "아직 시작 안 함"과 같은 말로 보이면 안 된다.** 환불은 실행을
  // 눌러도 카드사·은행을 거쳐 며칠이 걸리는데, 그 구간에 "지급 준비 중"만 뜨면
  // 구매자는 아무도 손대지 않은 줄 알고 문의한다 — 판정 결과는 이미 실패로 보이는데
  // 돈은 안 들어온 상태라 불신이 그대로 쌓인다
  const refundStarted = purchase?.settlement?.refundAttempts.some(
    (a) => a.status === "PENDING" || a.status === "SUCCEEDED",
  );
  // **판정이 밀리고 있다는 사실을 감추지 않는다** (2026-08-16).
  //
  // 두 시세 소스가 갈려 자동 판정을 세운 동안, 구매자 화면에는 종전대로 "판정 대기"만
  // 떴다. 그런데 이 상태는 하루가 넘을 수 있고, **에스크로에 돈이 묶인 채 아무 설명이
  // 없는 것**이 이 서비스에서 가장 비싼 침묵이다 — 구매자가 가장 두려워하는 것이
  // "플랫폼이 자기 사정으로 판정을 미루거나 주무르는 것"이기 때문이다.
  //
  // 문구는 **장애가 아니라 검증으로** 적는다. 사실이 그렇다: 우리는 한 소스가 틀렸을
  // 가능성을 보고 멈춘 것이고, 그대로 판정하는 것보다 멈추는 편이 구매자에게 낫다.
  // 그리고 **끝나는 시각을 함께 적는다** — "언제 끝나는가"에 답이 없는 지연이
  // 불신을 만든다 (유예의 상한이 코드로 정해져 있으므로 지킬 수 있는 약속이다).
  const judgmentDelayed =
    purchase?.escrowStatus === "HELD" &&
    card !== null &&
    !judgment &&
    (await isJudgmentPaused(prisma, card.assetClass as AssetClass));

  const purchaseStatus: { label: string; status: StatusKind } | null = purchase
    ? purchase.escrowStatus === "HELD"
      ? judgmentDelayed
        ? { label: "시세 정밀 검증 중 · 에스크로 보관 중", status: "VERIFYING" }
        : { label: "판정 대기 · 에스크로 보관 중", status: "VERIFYING" }
      : purchase.escrowStatus === "REFUNDED"
        ? purchase.settlement?.refundExecutedAt
          ? { label: "환불 완료", status: refundStatus }
          : refundStarted
            ? { label: "환불 처리 중 (3~5영업일 소요)", status: refundStatus }
            : { label: "환불 확정 · 지급 준비 중", status: refundStatus }
        : { label: "적중 · 정산 완료", status: "HIT" }
    : null;

  // 마스킹 상태의 표에서만 쓴다 — 열린 뒤의 방향·크기는 RevealedCard가 맡는다
  const dir = card?.direction === "UP" ? "▲ 상승 (buy)" : "▼ 하락 (sell)";

  // 구매 전 마스킹 — 종목·목표 수익률이 곧 상품이라, 사기 전에는
  // 자산군·방향·수익성(자동 산출 5구간)·시한·신뢰도까지만 보여준다.
  // 판정이 끝난 카드는 상품 가치가 소진된 공개 기록이므로 전부 공개하고,
  // 리서처 본인에게도 가리지 않는다.
  const isOwner = viewerId !== null && report.researcher.user.id === viewerId;
  const masked = !!card && !purchased && !judgment && !isOwner;
  const profitabilityLevel = card ? cardProfitabilityLevel(card) : null;
  // 안정성 — 게시 시점에 잰 종목 실현 변동성의 5구간 (시스템 산정, 점수 무관)
  const stabilityStars = cardStabilityLevel(card?.sigmaDaily);
  const now = new Date();

  // 카드별 신고 확률 — 별점 각주가 이 카드의 난이도(p₀)로 정확한 값을 말하게 한다.
  // vmax에서 이것은 "손해가 아니려면 믿어야 하는 최소 확률"이자 곧 **신고한 확률 그 자체**다
  // (적정 점수법이라 둘이 같은 값이다 — v4에서는 승산 조건을 풀어야 나오던 값이었다).
  // 게시 전(기간 미확정)이나 기준가 없는 소급 카드는 계산하지 않는다
  let cardClaimed: { p0: number; claimed: number } | null = null;
  if (card && report.publishedAt) {
    const magnitudePct =
      card.targetType === "RETURN_PCT"
        ? card.targetValue
        : card.basePrice && card.basePrice > 0
          ? (Math.abs(card.targetValue - card.basePrice) / card.basePrice) * 100
          : null;
    if (magnitudePct !== null && magnitudePct > 0) {
      const horizonDays =
        (card.deadline.getTime() - report.publishedAt.getTime()) / 86_400_000;
      if (horizonDays > 0) {
        const p0 = noSkillTouchProbability(
          card.direction as Direction,
          magnitudePct,
          card.assetClass as AssetClass,
          horizonDays,
          // 채점과 같은 σ를 쓴다 — 각주가 말하는 문턱이 실제 배당과 어긋나면 안 된다
          card.sigmaDaily,
        );
        cardClaimed = { p0, claimed: claimedProbability(p0, card.confidence) };
      }
    }
  }

  // 지금 실제로 살 수 있나 — **결제 관문(assertPurchasable)과 같은 기준으로 판단한다.**
  // 저장된 salesClosedAt만 보면 화면이 서버보다 헐거워진다: 판매 기간이 끝났는데
  // 배치가 아직 기록 전이면 구매 버튼이 그대로 떠 있고, 눌러야 에러를 만난다.
  // 화면이 "살 수 있다"고 말한 것은 서버도 그렇게 답해야 한다
  // 규율 상한도 관문이 본다 — 상한 위의 확신은 팔지 않는다(가역적 중단).
  // 화면이 먼저 알아야 "구매" 버튼이 떠 있다가 눌렀을 때 거절당하는 일이 없다
  const disciplineCap = card
    ? await researcherConfidenceCap(
        prisma,
        report.researcherId,
        card.assetClass as AssetClass,
        now,
      )
    : null;
  // 신고 누적에 의한 가역적 중단 — 규율 상한과 같은 성격이라 같은 자리에서 본다.
  // 화면이 먼저 알아야 구매 버튼이 떠 있다가 눌렀을 때 거절당하는 일이 없다
  const abuseSuspended = free ? false : await isAbuseSuspended(prisma, report.id);
  // 신고를 뺀 나머지 조건 — **"일시 중단"이라고 말해도 되는지**가 여기서 갈린다.
  // 이미 마감된 리포트에 "확인이 끝나면 다시 구매할 수 있습니다"라고 적으면 거짓말이다
  // (판매 기간은 이미 지났고 돌아오지 않는다). 신고가 **유일한 걸림돌일 때만** 중단으로 말한다
  const otherwiseSellable =
    !report.salesClosedAt &&
    !judgment &&
    (!card || card.deadline > now) &&
    (card == null || disciplineCap == null || card.confidence <= disciplineCap) &&
    isSalesWindowOpen(report.publishedAt, card?.deadline, now);
  const sellable = otherwiseSellable && !abuseSuspended;

  // 괴리 고지 상태 — 결제 직전과 같은 실시간 시세(60초 캐시)로 잰다.
  // 시세·기준가가 없으면 고지하지 않는다 (지어내지 않는다). 문구는 비율만 쓴다
  let salesNotice: SalesNoticeState = "NONE";
  if (card && !purchased && sellable && card.basePrice != null && card.basePrice > 0) {
    const cur = await fetchCachedPrice(card.assetClass, card.ticker);
    if (cur !== null) {
      const targetPrice =
        card.targetType === "TARGET_PRICE"
          ? card.targetValue
          : magnitudePctToTargetPrice(
              card.basePrice,
              card.direction as Direction,
              card.targetValue,
            );
      const magnitudePct =
        card.targetType === "RETURN_PCT"
          ? card.targetValue
          : (Math.abs(card.targetValue - card.basePrice) / card.basePrice) * 100;
      if (magnitudePct > 0) {
        salesNotice = salesNoticeState(
          remainingFraction(card.direction as Direction, cur, targetPrice, magnitudePct),
        );
      }
    }
  }

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
      {/* 별 세 줄의 **순서는 카드(MaskedCard.RATINGS)와 같아야 한다** — 목록에서 보던
          카드를 눌러 들어온 화면이라, 같은 값이 다른 자리에 있으면 값이 바뀐 것으로
          읽힌다. 실제로 그렇게 보여서 순서를 맞췄다 (2026-08-12) */}
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
      {/* 안정성 — 자기 신고 다이얼(v3)이 아니라 **종목 변동성으로 시스템이 매긴 값**.
          점수와 무관한 표시 지표라 각주로 출처를 밝힌다 (밝히지 않으면 리서처의
          신고로 오해된다 — 자기 신고 별점을 걷어낸 이유가 그 오해였다) */}
      <div className={styles.cardRow}>
        <span className={styles.cardKey}>안정성</span>
        <span className={styles.cardVal}>
          {stabilityStars === null ? (
            "—"
          ) : (
            <StarRating stars={stabilityStars} label="안정성" />
          )}
        </span>
      </div>
      <div className={styles.cardRow}>
        <span className={styles.cardKey}>신뢰도</span>
        <span className={styles.cardVal}>
          <StarRating stars={confidenceStars(card.confidence)} label="신뢰도" />
        </span>
      </div>
      {/* 별점 읽는 법 — 구매자의 알 권리 (점수 vmax 기준).
          별은 다이얼값에 선형이지만(별 한 칸 = 승산 ×1.73), 그 칸이 **몇 %를 뜻하는지**는
          카드 난이도(무정보 도달 확률 p₀)에 따라 달라진다. 그래서 고정 문구가 아니라
          이 카드의 p₀로 계산한 신고 확률을 적는다 — 채점이 쓰는 claimedProbability 그대로 */}
      <p className={styles.cardFootnote}>
        {cardClaimed !== null ? (
          <>
            이 카드 기준: 아무 정보 없이 찍어도 {Math.round(cardClaimed.p0 * 100)}%
            확률로 닿는 사양입니다. 리서처가 신고한 적중 확률은{" "}
            <strong>{Math.round(cardClaimed.claimed * 100)}%</strong>이고(신뢰도{" "}
            {card.confidence}), 이보다 자주 맞혀야 점수가 남습니다.
          </>
        ) : (
          <>신뢰도 별점은 리서처가 신고한 적중 확률입니다.</>
        )}{" "}
        안정성 별점은 리서처 입력이 아니라 종목의 최근 변동성으로 시스템이
        매기며, 점수·정산과 무관합니다. 채점은 {SCORE_MODEL_NAME}를 따릅니다.{" "}
        <Link href="/score" className={styles.cardFootnoteLink}>
          산정 방식 직접 계산해 보기 →
        </Link>
      </p>
      {/* 판매 중 보장 고지 — 실제로 집행되는 규칙(결제 순간 남은 몫 < 광고 폭의 절반 →
          결제 차단)을 구매자 언어로. **비율만 말한다** — 실제 수치를 적으면 비공개인
          목표 수익률이 역산된다. 고지는 규칙까지, 결제 관문의 집행이 그 말을 참으로 만든다 */}
      {masked && <p className={styles.cardFootnote}>{salesGuaranteeText()}</p>}
      {/* 괴리 고지 — 결제 직전 실시간 시세로 잰 상태 (사용자 확정: 실시간).
          부족: 광고 폭을 다 못 챙기는 상태. 초과: 예측이 반대로 가 있는 상태 —
          "더 먹을 수 있다"가 아니라 **경고**다 (그 상태의 구매는 적중 확률이
          게시 직후의 3~5할이다, scripts/simSalesBand.ts) */}
      {masked && salesNotice === "SHORTFALL" && (
        <p className={styles.cardFootnote}>
          ⚠ 지금 시세 기준, 광고한 목표 폭을 전부 확보할 수는 없는 상태입니다. 결제는 남은
          폭이 광고 폭의 절반 이상일 때만 승인됩니다.
        </p>
      )}
      {masked && salesNotice === "EXCESS" && (
        <p className={styles.cardFootnote}>
          ⚠ 현재 시세가 게시 시점보다 예측 반대 방향에 있습니다. 남은 폭은 커 보이지만,
          지금까지는 예측이 빗나가는 중이라는 뜻이니 유의하세요. 반대로 목표 폭만큼
          벌어지면 판매는 그 시점에 마감됩니다.
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
  //
  // **이의제기 입구를 영수증 바로 아래 둔다.** 판정 근거를 본 직후가 "이게 맞나?"라는
  // 물음이 생기는 유일한 자리다. 여기 없으면 그 사람이 다음으로 가는 곳은 카드사다
  // (차지백 — 우리가 아무것도 못 하는 자리에서 돈이 빠진다)
  const receipt = card && judgment && (
    <>
      <JudgmentReceipt card={card} judgment={judgment} />
      {purchase && (disputable || purchase.judgmentDispute) && (
        <DisputeForm purchaseId={purchase.id} alreadyFiled={!!purchase.judgmentDispute} />
      )}
    </>
  );

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
          {/* **환불받은 사람이 다음에 갈 곳이 없다** — 돈은 돌려받았지만 시간은 못
              돌려받았고, 그 상태로 앱을 닫으면 다시 안 온다(지표 ④·⑥).
              그렇다고 카드를 골라 주지는 않는다: 플랫폼이 특정 종목·리서처를 **짚는**
              순간 투자권유 해석이 열린다. 안전선은 **목록**이다 —
              ① 개인화하지 않는다(누가 보든 같은 링크) ② 종목·리서처를 지목하지 않는다
              ③ 거는 조건은 시장 판단이 아니라 **상품 조건**(선결제 0% = 틀리면 전액 환불)이다.
              집계된 사실로만 이뤄진 필터라 컨센서스·히트맵과 같은 선 안쪽에 있다 */}
          {purchase?.settlement && purchase.settlement.buyerRefundKrw > 0 && (
            <p className={styles.sub}>
              <Link href="/leaderboard?refund=1">
                지금 열려 있는 무위험 예측 보기 (틀리면 100% 현금 환불) →
              </Link>
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
                {PAYMENT_METHOD_LABEL[purchase.paymentMethod] ?? purchase.paymentMethod}
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
                {/*
                  끝나는 시각을 함께 적는다 — "언제 끝나는가"에 답이 없는 지연이
                  불신을 만든다. 유예의 상한이 코드로 정해져 있어 지킬 수 있는 약속이다
                */}
                {judgmentDelayed && (
                  <small
                    style={{
                      display: "block",
                      marginTop: 6,
                      fontWeight: 500,
                      color: "var(--text-weak)",
                      lineHeight: 1.55,
                    }}
                  >
                    시세 제공사의 데이터 정합성을 재검증하고 있습니다. 검증이 끝나면
                    판정되고, 끝나지 않으면 <b>전액 환불</b>됩니다 — 어느 쪽이든
                    검증 시한 후 최대 {JUDGMENT_ABSOLUTE_CAP_DAYS}일 안에 확정됩니다.
                  </small>
                )}
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
      ) : report.status === "PUBLISHED" && abuseSuspended && otherwiseSellable ? (
        // **마감과 중단은 다른 말이다.** 마감은 불가역이고 이건 확인이 끝나면 풀린다 —
        // 같은 문구를 쓰면 다시 팔릴 리포트를 끝난 것으로 읽게 만든다.
        // 다만 사유("신고 누적")는 쓰지 않는다: 확인되지 않은 혐의를 시장에 방송하는 것이
        // 되고, 기각되면 남는 것은 방송된 혐의뿐이다 (domain/abuseSuspension.ts)
        <div className={styles.locked}>{ABUSE_SUSPENDED_MESSAGE}</div>
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

      {/* 신고는 **누구나, 언제나** 할 수 있어야 한다 — 사기 전에도(구매 전 화면의 표현만
          보고도 알 수 있는 위반이 있다) 사고 나서도(본문을 읽어야 보이는 위반이 더 많다).
          자기 리포트와 무료 시황만 뺀다: 자기 것은 신고할 이유가 없고, 무료 글은
          예측 카드가 없어 판매를 멈출 대상이 아니다 */}
      {!free && viewerId && !isOwner && <ReportAbuseLink reportId={report.id} />}

      <Disclaimer />
      </main>
    </>
  );
}
