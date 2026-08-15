import type { PrismaClient } from '@prisma/client';

// 운영 초기(거래 100건·리서처 10명 구간)에 **매일 눈으로 보는 여섯 숫자.**
//
// 기존 계측(에스크로 잔액·스케줄러 심박·이월 건수)은 전부 **"인프라가 죽었는가"**를
// 본다. 그것들이 전부 초록이어도 서비스는 조용히 죽을 수 있다 — 카드가 안 팔리고,
// 판정이 오래 걸리고, 환불받은 사람이 다시 안 오면 시스템은 완벽하게 동작하면서
// 망한다. 여기 있는 것은 **"사업 로직이 죽어가고 있는가"**를 보는 숫자다.
//
// 초기 구간 전용이라 표본이 작다. 그래서 **비율에는 반드시 분모를 함께 싣는다** —
// 1건 중 1건이 100%로 표시되면 그건 지표가 아니라 오도다.

export interface OpsMetric {
  key: string;
  label: string;
  /** 표시용 값 (숫자가 없으면 '—') */
  value: string;
  /** 분모·표본 — 비율은 이것 없이 읽으면 안 된다 */
  sample: string;
  /** 이 숫자가 나빠지면 무엇이 무너지는가 — 보는 사람이 매번 되묻지 않도록 */
  meaning: string;
  /** 눈에 띄어야 하는 상태 (문턱은 초안 — 운영 데이터로 재조정) */
  alert: boolean;
}

const pct = (n: number, d: number) => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);
const days = (ms: number) => (ms / 86_400_000).toFixed(1);

/**
 * ⑥의 관측 창 — 판정 후 이 기간 안에 다시 샀는가.
 *
 * **임의 상수인 것을 인정한다.** 그래도 평균 소요 시간보다 나은 이유는 아래
 * `fixedHorizonReturn` 주석에 있다. 카드 시한(최대 365일)과 맞출 필요는 없다 —
 * 구매자가 다음 카드를 사는 데 자기 카드의 판정을 기다릴 이유가 없기 때문이다.
 * 14일인 이유는 **선행 지표이기를 포기하지 않는 선**이다: 30일로 늘리면 표본은
 * 늘지만 문제를 30일 늦게 안다.
 */
export const RETURN_HORIZON_DAYS = 14;

/**
 * ① 결제 → 판정까지 걸린 실제 일수.
 *
 * **이 숫자는 두 가지를 동시에 잰다.** 구매자에게는 "피드백까지의 대기"이고,
 * 리서처에게는 **현금전환주기(CCC)** 그 자체다 — 그동안 매출은 에스크로에 묶여 있다.
 * 길어지면 콜드스타트가 양쪽에서 동시에 언다: 구매자는 결과를 못 보고, 리서처는
 * "3개월 동안 한 푼도 못 받는 곳"이 된다. **A급 공급자가 조용히 이탈하는 경로가 여기다.**
 */
/**
 * **판정 → 지급 실행까지** (2026-08-15).
 *
 * 기존 leadTime(결제 → 판정)은 카드 시한이 정하므로 우리가 못 줄인다. 반면 이 구간은
 * **전부 우리 것**이다 — 쿨다운 48시간 + 운영자가 버튼을 누르기까지.
 *
 * 나눠서 재는 이유: 리서처 이탈을 "정산이 느리다"로 뭉뜽그리면 손댈 곳을 못 찾는다.
 * 시한 때문이면 상품(짧은 카드가 팔리게)을 고쳐야 하고, 실행 지연 때문이면 운영
 * (자동 실행·알림)을 고쳐야 한다. 둘은 처방이 정반대다.
 */
async function payoutLatency(prisma: PrismaClient) {
  const rows = await prisma.settlement.findMany({
    where: { payoutExecutedAt: { not: null }, researcherPayoutKrw: { gt: 0 } },
    select: { settledAt: true, payoutExecutedAt: true },
  });
  const spans = rows
    .map((r) => (r.payoutExecutedAt ? r.payoutExecutedAt.getTime() - r.settledAt.getTime() : null))
    .filter((v): v is number => v !== null && v >= 0);
  const avg = spans.length > 0 ? spans.reduce((a, b) => a + b, 0) / spans.length : null;
  return { avg, n: spans.length };
}

async function judgmentLeadTime(prisma: PrismaClient) {
  const rows = await prisma.purchase.findMany({
    where: {
      escrowStatus: { notIn: ['CANCELLED'] },
      report: { predictionCard: { judgment: { isNot: null } } },
    },
    select: {
      paidAt: true,
      report: { select: { predictionCard: { select: { judgment: { select: { judgedAt: true } } } } } },
    },
  });
  const spans = rows
    .map((r) => {
      const judgedAt = r.report.predictionCard?.judgment?.judgedAt;
      return judgedAt ? judgedAt.getTime() - r.paidAt.getTime() : null;
    })
    // 음수는 시계가 어긋난 데이터다(픽스처의 가상 시각 등) — 평균을 오염시키지 않게 뺀다
    .filter((v): v is number => v !== null && v >= 0);
  const avg = spans.length > 0 ? spans.reduce((a, b) => a + b, 0) / spans.length : null;
  return { avg, n: spans.length };
}

/**
 * ② 한 건도 안 팔린 채 끝난 카드의 비율.
 *
 * 높으면 가격이 비싸거나, 리서처의 신뢰가 구매자에게 전혀 설득되지 않고 있다는 뜻이다.
 * **판정 정확성으로는 절대 드러나지 않는 종류의 실패다** — 판정 엔진은 완벽하게
 * 동작하는데 팔 물건이 아무도 안 사는 상태.
 */
async function zeroPurchaseRate(prisma: PrismaClient, now: Date) {
  // 이미 결판난 카드만 센다 — 아직 팔리는 중인 카드를 분모에 넣으면 늘 나쁘게 보인다
  const settled = await prisma.predictionCard.findMany({
    where: {
      report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
      OR: [{ judgment: { isNot: null } }, { deadline: { lt: now } }],
    },
    select: { report: { select: { _count: { select: { purchases: true } } } } },
  });
  const zero = settled.filter((c) => c.report._count.purchases === 0).length;
  return { zero, total: settled.length };
}

/**
 * ③ 판정에 이의가 제기된 비율.
 *
 * **이제 진짜 이의제기율이다.** 처음 이 지표를 짤 때는 "우리가 되돌린 판정"만 셀 수
 * 있었다 — 구매자가 "틀렸다"고 생각해도 말할 창구가 없어 **불만이 데이터가 되지
 * 못했기** 때문이다. 이의제기 창구(judgmentDisputeService)가 생기면서 그 구멍이 닫혔다.
 *
 * 되돌린 건도 함께 센다: 우리가 스스로 발견해 고친 것도 "판정과 현실이 어긋났다"는
 * 같은 사건이다. 올라가면 시세 데이터(배당락·수정주가)가 판정 로직을 부수고 있을
 * 확률이 높다. **인정률을 함께 보는 이유**: 이의는 많은데 인정이 없으면 판정이 아니라
 * 설명이 부족한 것이다(화면이 판정 근거를 못 보여주고 있다는 뜻).
 */
async function judgmentDisputeRate(prisma: PrismaClient) {
  const [filed, upheld, reverted, judged] = await Promise.all([
    prisma.judgmentDispute.count(),
    prisma.judgmentDispute.count({ where: { status: 'UPHELD' } }),
    prisma.judgmentRevert.count(),
    prisma.judgment.count(),
  ]);
  return { filed, upheld, reverted, judged: judged + reverted };
}

/**
 * ④ 판정을 한 번 겪은 구매자가 다시 샀는가 — **이 서비스의 존립을 결정하는 하나.**
 *
 * 특히 **환불받은 쪽**을 따로 본다. 환불이 "돈 돌려받아 다행"으로 읽히면 다시 오고,
 * "시간만 낭비했다"로 읽히면 안 온다. 둘의 차이는 환불 금액이 아니라 그 경험의
 * 값어치이고, 그건 이 숫자 말고 볼 방법이 없다.
 *
 * ⑥의 입력도 여기서 함께 낸다 — 코호트 정의(첫 판정·환불 여부)가 같아야 두 지표가
 * 같은 사람을 말한다. 조회를 두 번 하면 정의가 갈라지는 것은 시간 문제다.
 */
async function repurchaseAfterJudgment(prisma: PrismaClient, now: Date) {
  const purchases = await prisma.purchase.findMany({
    where: { escrowStatus: { not: 'CANCELLED' } },
    select: {
      buyerId: true,
      paidAt: true,
      settlement: { select: { buyerRefundKrw: true } },
      report: {
        select: { predictionCard: { select: { judgment: { select: { judgedAt: true } } } } },
      },
    },
    orderBy: { paidAt: 'asc' },
  });

  const byBuyer = new Map<string, typeof purchases>();
  for (const p of purchases) {
    const list = byBuyer.get(p.buyerId) ?? [];
    list.push(p);
    byBuyer.set(p.buyerId, list);
  }

  let cohort = 0;
  let returned = 0;
  let refundedCohort = 0;
  let refundedReturned = 0;
  // ⑥의 입력 — **고정 지평 안에서만 센다** (아래 fixedHorizonReturn 주석).
  // 관측 창이 아직 안 닫힌 사람은 어느 쪽에도 넣지 않는다 — 넣으면 "아직 안 온 것"과
  // "영영 안 올 것"이 같은 칸에 들어간다
  const horizon = { refunded: { n: 0, back: 0 }, hit: { n: 0, back: 0 } };
  for (const list of byBuyer.values()) {
    // 그 사람이 **처음 겪은 판정**의 시각 — 그 뒤에 또 샀는지를 본다
    const firstJudged = list
      .map((p) => p.report.predictionCard?.judgment?.judgedAt)
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!firstJudged) continue;

    cohort++;
    // 정렬이 paidAt 오름차순이라 첫 원소가 곧 "판정 뒤 처음 산 것"이다
    const next = list.find((p) => p.paidAt > firstJudged);
    if (next) returned++;

    // 첫 판정이 환불로 끝난 사람만 따로 — 환불 경험의 값어치를 재는 자리
    const wasRefunded = list.some(
      (p) =>
        p.report.predictionCard?.judgment?.judgedAt?.getTime() === firstJudged.getTime() &&
        (p.settlement?.buyerRefundKrw ?? 0) > 0,
    );
    if (wasRefunded) {
      refundedCohort++;
      if (next) refundedReturned++;
    }

    // ⑥ — **관측 창이 닫힌 사람만** 분모에 넣고, 그 창 안의 재구매만 분자에 넣는다
    const windowEnd = firstJudged.getTime() + RETURN_HORIZON_DAYS * 86_400_000;
    if (now.getTime() >= windowEnd) {
      const bucket = wasRefunded ? horizon.refunded : horizon.hit;
      bucket.n++;
      if (next && next.paidAt.getTime() <= windowEnd) bucket.back++;
    }
  }
  return { cohort, returned, refundedCohort, refundedReturned, horizon };
}

/**
 * ⑥ 판정 후 **14일 안에 다시 샀는가** — 환불 코호트 vs 적중 코호트.
 *
 * ④(재구매율)는 사후 지표다. 떨어진 것을 알았을 때는 그 사람들이 이미 떠난 뒤라
 * 손쓸 시점이 지나 있다. 이 지표는 그보다 앞서 움직인다 — 같은 관측 창을 두 코호트에
 * 똑같이 씌우면 **"환불 경험이 재구매를 얼마나 깎는가"**가 바로 읽힌다.
 *
 * ── 왜 "평균 재구매 소요 시간"을 버렸나 (2026-08-15) ──────────
 * 처음 구현은 되돌아온 사람의 **간격 중앙값**을 두 코호트로 나눠 봤다. 우측 절단
 * (right-censoring) 때문에 **통계적으로 유해한 지표**였다: 영영 안 온 사람은 간격이
 * 없어 분자에도 분모에도 안 들어가고, 그래서 **코호트가 통째로 떠날수록 숫자가
 * 오히려 좋아진다.** 가장 나쁜 상황에서 가장 예쁜 값이 나오는 지표는 지표가 아니다.
 * 분모를 함께 싣고 ④와 같이 읽는 것으로 막아 뒀었는데, 그건 **읽는 사람의 규율에
 * 기대는 방어**라 언젠가 뚫린다.
 *
 * 고정 지평은 그 구멍을 **정의로** 닫는다. 관측 창이 아직 안 닫힌 사람은 분모에서
 * 빼고(아직 기회가 안 끝났다), 창이 닫힌 사람은 돌아왔든 아니든 전부 분모에 남는다.
 * 떠난 사람이 분모에 남으므로 이탈이 늘면 숫자가 **내려간다** — 방향이 바로 섰다.
 *
 * Kaplan-Meier(생존 분석)가 절단을 정면으로 다루는 정답이지만, 거래 100건 구간에서
 * 그 곡선을 그리는 것은 정밀도의 착시다. 신뢰구간이 화면을 덮는다.
 *
 * ⚠ **대가가 있다: 최근 14일이 안 보인다.** 창이 닫히지 않은 사람은 분모에 없으므로
 * 이 지표는 항상 2주 전의 세상을 말한다. 하필 문제가 가장 신선할 때 침묵하는 것이라,
 * 급성 사고는 ④와 ③이 먼저 잡아야 한다. 절단 편향과 관측 지연 중 무엇을 택할
 * 것이냐의 문제였고, **거짓말하지 않는 쪽**을 택했다.
 *
 * (후보였던 "리포트 완독률"은 계측을 새로 붙여야 하는 데다 이 상황에서 **거꾸로
 * 작동한다** — 끝까지 읽고 기다렸다 실패한 사람이 기회비용을 가장 크게 잃었다.)
 */
function fixedHorizonReturn(h: { refunded: { n: number; back: number }; hit: { n: number; back: number } }) {
  const rate = (b: { n: number; back: number }) => (b.n === 0 ? null : b.back / b.n);
  const refunded = rate(h.refunded);
  const hit = rate(h.hit);
  return {
    refunded,
    hit,
    /** 적중군이 환불군의 몇 배로 돌아오는가 — 1에 가까울수록 환불 경험이 중립적이다 */
    ratio: refunded !== null && hit !== null && refunded > 0 ? hit / refunded : null,
  };
}

/**
 * ⑤ 운영자가 손으로 상태를 바꾼 횟수 — **확장 가능성의 지표다.**
 *
 * 100건에 5건을 손대고 있다면 1,000건에서는 50건이고, 그 시점에 운영자는 과로하고
 * 시스템은 사람 속도로 내려앉는다. 자동화의 우선순위를 이 숫자가 정한다.
 */
async function manualInterventions(prisma: PrismaClient) {
  const [reverts, manualJudgments, takedowns, csVoids, disputes] = await Promise.all([
    prisma.judgmentRevert.count(),
    prisma.judgment.count({ where: { dataSource: { startsWith: 'manual:' } } }),
    prisma.judgment.count({ where: { dataSource: { startsWith: 'takedown:' } } }),
    prisma.refundAttempt.count({ where: { type: 'CS_CANCEL' } }),
    prisma.purchase.count({ where: { escrowStatus: 'DISPUTED' } }),
  ]);
  const total = reverts + manualJudgments + takedowns + csVoids + disputes;
  const judged = await prisma.judgment.count();
  return { total, judged, breakdown: { reverts, manualJudgments, takedowns, csVoids, disputes } };
}

/** 문턱은 전부 **초안**이다 — 운영 데이터가 쌓이면 다시 잡는다 */
export const OPS_THRESHOLDS = {
  /** 결제→판정이 이보다 길면 리서처 현금흐름이 조인다 */
  leadTimeDays: 60,
  /**
   * 판정→지급이 이보다 길면 **우리가 늦추고 있는 것**이다.
   * 쿨다운이 2일이므로 3일은 "쿨다운 직후 다음 영업일"까지의 여유다 — 넘으면
   * 운영자가 큐를 안 열고 있다는 뜻이고, 그건 자동 실행을 검토할 신호다.
   */
  payoutLatencyDays: 3,
  /** 안 팔린 카드가 절반을 넘으면 가격이나 신뢰 설득에 문제가 있다 */
  zeroPurchaseRate: 0.5,
  /** 이의·정정이 이 비율을 넘으면 시세 데이터가 판정 로직을 부수고 있다 */
  disputeRate: 0.03,
  /** 판정 경험자의 재구매가 이 아래면 상품 경험 자체가 실패다 */
  repurchaseRate: 0.2,
  /**
   * 적중군의 14일 재구매율이 환불군의 이 배를 넘으면 환불 경험이 값어치를 잃고 있는 것이다.
   * 1.5배는 초안 — 실제 데이터가 쌓이면 다시 잡는다
   */
  returnGapRatio: 1.5,
  /** 그 아래 표본에서는 경보를 울리지 않는다 — 두 사람의 변덕이 배율을 만든다 */
  returnGapMinSample: 3,
  /** 판정 100건당 수동 개입이 이보다 많으면 사람 속도가 병목이 된다 */
  interventionsPer100: 5,
} as const;

export async function getOpsMetrics(prisma: PrismaClient, now = new Date()): Promise<OpsMetric[]> {
  const [lead, payout, zero, revert, repurchase, manual] = await Promise.all([
    judgmentLeadTime(prisma),
    payoutLatency(prisma),
    zeroPurchaseRate(prisma, now),
    judgmentDisputeRate(prisma),
    repurchaseAfterJudgment(prisma, now),
    manualInterventions(prisma),
  ]);

  const per100 = manual.judged === 0 ? 0 : (manual.total / manual.judged) * 100;
  const h = repurchase.horizon;
  const gap = fixedHorizonReturn(h);

  return [
    {
      key: 'leadTime',
      label: '결제 → 판정 평균',
      value: lead.avg === null ? '—' : `${days(lead.avg)}일`,
      sample: `판정 완료 ${lead.n}건`,
      meaning:
        '구매자에게는 피드백 대기, 리서처에게는 현금전환주기(CCC) 그 자체입니다. 길어지면 A급 리서처가 조용히 이탈합니다.',
      alert: lead.avg !== null && lead.avg / 86_400_000 > OPS_THRESHOLDS.leadTimeDays,
    },
    {
      key: 'payoutLatency',
      label: '판정 → 지급 실행',
      value: payout.avg === null ? '—' : `${days(payout.avg)}일`,
      sample: `지급 완료 ${payout.n}건`,
      meaning:
        '위 지표는 카드 시한이 정하지만 이 구간은 전부 우리 것입니다 — 쿨다운 2일 + 운영자가 버튼을 누르기까지. 리서처 이탈을 "정산이 느리다"로 뭉뚱그리면 손댈 곳을 못 찾습니다.',
      alert:
        payout.avg !== null && payout.avg / 86_400_000 > OPS_THRESHOLDS.payoutLatencyDays,
    },
    {
      key: 'zeroPurchase',
      label: '한 건도 안 팔린 카드',
      value: pct(zero.zero, zero.total),
      sample: `결판난 카드 ${zero.total}장 중 ${zero.zero}장`,
      meaning:
        '판정 엔진이 완벽해도 물건이 안 팔리면 서비스는 죽습니다. 높으면 가격이거나, 리서처 신뢰가 설득되지 않는 것입니다.',
      alert:
        zero.total > 0 && zero.zero / zero.total > OPS_THRESHOLDS.zeroPurchaseRate,
    },
    {
      key: 'disputeRate',
      label: '판정 이의·정정',
      value: pct(revert.filed + revert.reverted, revert.judged),
      sample:
        `전체 판정 ${revert.judged}건 중 이의 ${revert.filed}건(인정 ${revert.upheld}) · 우리가 되돌린 것 ${revert.reverted}건`,
      meaning:
        '올라가면 시세 데이터(배당락·수정주가)가 판정 로직을 부수고 있을 확률이 높습니다. 이의는 많은데 인정이 없으면 판정이 아니라 판정 근거를 보여주는 화면이 부족한 것입니다.',
      alert:
        revert.judged > 0 &&
        (revert.filed + revert.reverted) / revert.judged > OPS_THRESHOLDS.disputeRate,
    },
    {
      key: 'repurchase',
      label: '판정 경험 후 재구매',
      value: pct(repurchase.returned, repurchase.cohort),
      sample:
        `판정을 겪은 구매자 ${repurchase.cohort}명 중 ${repurchase.returned}명` +
        ` · 그중 환불 경험자 ${pct(repurchase.refundedReturned, repurchase.refundedCohort)}` +
        ` (${repurchase.refundedCohort}명 중 ${repurchase.refundedReturned}명)`,
      meaning:
        '이 서비스의 존립을 결정하는 하나입니다. 환불받은 사람이 안 돌아오면 "돈은 돌려받았지만 시간을 낭비했다"는 뜻입니다.',
      alert:
        repurchase.cohort > 0 &&
        repurchase.returned / repurchase.cohort < OPS_THRESHOLDS.repurchaseRate,
    },
    {
      key: 'returnGap',
      label: `판정 후 ${RETURN_HORIZON_DAYS}일 내 재구매 (환불 / 적중)`,
      value:
        gap.refunded === null && gap.hit === null
          ? '—'
          : `${gap.refunded === null ? '—' : (gap.refunded * 100).toFixed(1) + '%'} / ` +
            `${gap.hit === null ? '—' : (gap.hit * 100).toFixed(1) + '%'}` +
            (gap.ratio === null ? '' : ` (${gap.ratio.toFixed(2)}배)`),
      sample:
        `환불 ${h.refunded.n}명 중 ${h.refunded.back}명 · 적중 ${h.hit.n}명 중 ${h.hit.back}명. ` +
        `판정한 지 ${RETURN_HORIZON_DAYS}일이 안 된 사람은 아직 분모에 없습니다`,
      meaning:
        `④가 무너지기 전에 먼저 움직이는 신호입니다. 두 코호트에 같은 관측 창을 씌워 "환불 경험이 재구매를 얼마나 깎는가"를 직접 봅니다. 적중군이 환불군의 ${OPS_THRESHOLDS.returnGapRatio}배 넘게 돌아오면 환불이 "다행"이 아니라 "시간 낭비"로 읽히기 시작한 것입니다. 대신 최근 ${RETURN_HORIZON_DAYS}일은 이 숫자에 안 보입니다 — 급성 사고는 ③·④가 먼저 잡습니다.`,
      alert:
        gap.ratio !== null &&
        h.refunded.n >= OPS_THRESHOLDS.returnGapMinSample &&
        h.hit.n >= OPS_THRESHOLDS.returnGapMinSample &&
        gap.ratio > OPS_THRESHOLDS.returnGapRatio,
    },
    {
      key: 'manual',
      label: '수동 개입',
      value: `판정 100건당 ${per100.toFixed(1)}회`,
      sample:
        `총 ${manual.total}회 — 판정 되돌리기 ${manual.breakdown.reverts} · 수동 판정 ${manual.breakdown.manualJudgments} · ` +
        `강제 철회 ${manual.breakdown.takedowns} · CS 무효화 ${manual.breakdown.csVoids} · 분쟁 ${manual.breakdown.disputes}`,
      meaning:
        '확장 가능성의 지표입니다. 100건에 5건을 손대면 1,000건에서는 50건이고, 그때 사람이 병목이 됩니다.',
      alert: per100 > OPS_THRESHOLDS.interventionsPer100,
    },
  ];
}
