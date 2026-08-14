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

/** 중앙값 — 표본이 작을 때 한 사람의 6개월이 평균을 통째로 끌고 가는 것을 막는다 */
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * ① 결제 → 판정까지 걸린 실제 일수.
 *
 * **이 숫자는 두 가지를 동시에 잰다.** 구매자에게는 "피드백까지의 대기"이고,
 * 리서처에게는 **현금전환주기(CCC)** 그 자체다 — 그동안 매출은 에스크로에 묶여 있다.
 * 길어지면 콜드스타트가 양쪽에서 동시에 언다: 구매자는 결과를 못 보고, 리서처는
 * "3개월 동안 한 푼도 못 받는 곳"이 된다. **A급 공급자가 조용히 이탈하는 경로가 여기다.**
 */
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
 */
async function repurchaseAfterJudgment(prisma: PrismaClient) {
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
  // ⑥의 입력 — **되돌아온 사람이 얼마나 뜸을 들였나** (아래 timeToReturn 주석)
  const gapRefunded: number[] = [];
  const gapHit: number[] = [];
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
    if (next) {
      const gap = next.paidAt.getTime() - firstJudged.getTime();
      (wasRefunded ? gapRefunded : gapHit).push(gap);
    }
  }
  return { cohort, returned, refundedCohort, refundedReturned, gapRefunded, gapHit };
}

/**
 * ⑥ 판정을 겪은 뒤 **다시 사기까지 걸린 시간** — 환불 코호트 vs 적중 코호트.
 *
 * ④(재구매율)는 사후 지표다. 떨어진 것을 알았을 때는 그 사람들이 이미 떠난 뒤라
 * 손쓸 시점이 지나 있다. **떠나기 전에 잡히는 신호**가 필요한데, 이탈은 "안 온다"로
 * 오기 전에 **"점점 늦게 온다"**로 먼저 온다.
 *
 * 그래서 두 코호트의 재구매 간격을 견준다. 환불받은 사람의 간격이 적중한 사람보다
 * 계통적으로 벌어지기 시작하면 그건 **"돈은 돌려받았지만 시간을 낭비했다"**가
 * 행동에 나타나기 시작한 것이다. 아직 재구매율은 안 떨어졌을 때 보인다.
 *
 * **후보로 검토한 "리포트 완독률"은 쓰지 않는다.** 스크롤·체류 추적을 새로 붙여야
 * 하는데다, 이 상황에서는 **거꾸로 작동한다** — 끝까지 읽고 기다렸다가 실패한 사람이
 * 기회비용을 가장 크게 잃은 사람이라 완독률이 높을수록 이탈 위험군이 커진다.
 * 여기 있는 값은 이미 가진 결제·판정 시각만으로 나와 새 계측이 0이다.
 *
 * ⚠ **되돌아온 사람만 센다(우측 절단).** 영영 안 온 사람은 간격이 없어 이 숫자에
 * 들어가지 않는다 — 코호트가 통째로 떠나면 간격이 오히려 **짧아 보인다.**
 * 그래서 분모(코호트 인원)를 반드시 함께 싣고, 이 지표는 ④와 **같이** 읽어야 한다.
 */
function timeToReturn(r: {
  cohort: number;
  refundedCohort: number;
  gapRefunded: number[];
  gapHit: number[];
}) {
  const refunded = median(r.gapRefunded);
  const hit = median(r.gapHit);
  return {
    refunded,
    hit,
    ratio: refunded !== null && hit !== null && hit > 0 ? refunded / hit : null,
    hitCohort: r.cohort - r.refundedCohort,
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
  /** 안 팔린 카드가 절반을 넘으면 가격이나 신뢰 설득에 문제가 있다 */
  zeroPurchaseRate: 0.5,
  /** 이의·정정이 이 비율을 넘으면 시세 데이터가 판정 로직을 부수고 있다 */
  disputeRate: 0.03,
  /** 판정 경험자의 재구매가 이 아래면 상품 경험 자체가 실패다 */
  repurchaseRate: 0.2,
  /**
   * 환불 코호트의 재구매 간격이 적중 코호트의 이 배를 넘으면 ④가 무너지기 시작한 것이다.
   * 1.5배는 초안 — 되돌아온 사람만 세는 지표라 코호트가 얇을 때는 흔들린다
   */
  returnGapRatio: 1.5,
  /** 그 아래 표본에서는 경보를 울리지 않는다 — 두 사람의 변덕이 배율을 만든다 */
  returnGapMinSample: 3,
  /** 판정 100건당 수동 개입이 이보다 많으면 사람 속도가 병목이 된다 */
  interventionsPer100: 5,
} as const;

export async function getOpsMetrics(prisma: PrismaClient, now = new Date()): Promise<OpsMetric[]> {
  const [lead, zero, revert, repurchase, manual] = await Promise.all([
    judgmentLeadTime(prisma),
    zeroPurchaseRate(prisma, now),
    judgmentDisputeRate(prisma),
    repurchaseAfterJudgment(prisma),
    manualInterventions(prisma),
  ]);

  const per100 = manual.judged === 0 ? 0 : (manual.total / manual.judged) * 100;
  const gap = timeToReturn(repurchase);

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
      label: '판정 후 재구매까지 (환불 / 적중)',
      value:
        gap.refunded === null || gap.hit === null
          ? '—'
          : `${days(gap.refunded)}일 / ${days(gap.hit)}일` +
            (gap.ratio === null ? '' : ` (${gap.ratio.toFixed(2)}배)`),
      sample:
        `되돌아온 사람만 — 환불 ${repurchase.gapRefunded.length}/${repurchase.refundedCohort}명 · ` +
        `적중 ${repurchase.gapHit.length}/${gap.hitCohort}명. 영영 안 온 사람은 이 숫자에 없습니다`,
      meaning:
        '④가 무너지기 전에 먼저 움직이는 신호입니다. 이탈은 "안 온다"로 오기 전에 "점점 늦게 온다"로 옵니다. 환불 쪽이 적중 쪽보다 1.5배 이상 벌어지면 환불이 "다행"이 아니라 "시간 낭비"로 읽히기 시작한 것입니다.',
      alert:
        gap.ratio !== null &&
        repurchase.gapRefunded.length >= OPS_THRESHOLDS.returnGapMinSample &&
        repurchase.gapHit.length >= OPS_THRESHOLDS.returnGapMinSample &&
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
