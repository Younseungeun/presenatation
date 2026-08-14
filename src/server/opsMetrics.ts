import type { PrismaClient } from '@prisma/client';

// 운영 초기(거래 100건·리서처 10명 구간)에 **매일 눈으로 보는 다섯 숫자.**
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
 * ③ 우리가 되돌린 판정의 비율.
 *
 * ⚠ **이건 "이의제기율"의 대용품이지 이의제기율이 아니다.** 구매자가 "판정이 틀렸다"고
 * 말했지만 우리가 받아들이지 않은 건은 **어디에도 기록되지 않는다** — 지금 구조에
 * 이의를 접수하는 창구 자체가 없기 때문이다. 그래서 이 숫자는 실제보다 항상 낮다.
 * 올라가면 시세 데이터(배당락·수정주가)가 판정 로직을 부수고 있을 확률이 높다.
 */
async function judgmentRevertRate(prisma: PrismaClient) {
  const [reverted, judged] = await Promise.all([
    prisma.judgmentRevert.count(),
    prisma.judgment.count(),
  ]);
  return { reverted, judged: judged + reverted };
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
  for (const list of byBuyer.values()) {
    // 그 사람이 **처음 겪은 판정**의 시각 — 그 뒤에 또 샀는지를 본다
    const firstJudged = list
      .map((p) => p.report.predictionCard?.judgment?.judgedAt)
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (!firstJudged) continue;

    cohort++;
    const again = list.some((p) => p.paidAt > firstJudged);
    if (again) returned++;

    // 첫 판정이 환불로 끝난 사람만 따로 — 환불 경험의 값어치를 재는 자리
    const wasRefunded = list.some(
      (p) =>
        p.report.predictionCard?.judgment?.judgedAt?.getTime() === firstJudged.getTime() &&
        (p.settlement?.buyerRefundKrw ?? 0) > 0,
    );
    if (wasRefunded) {
      refundedCohort++;
      if (again) refundedReturned++;
    }
  }
  return { cohort, returned, refundedCohort, refundedReturned };
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
  /** 되돌린 판정이 이 비율을 넘으면 시세 데이터가 로직을 부수고 있다 */
  revertRate: 0.03,
  /** 판정 경험자의 재구매가 이 아래면 상품 경험 자체가 실패다 */
  repurchaseRate: 0.2,
  /** 판정 100건당 수동 개입이 이보다 많으면 사람 속도가 병목이 된다 */
  interventionsPer100: 5,
} as const;

export async function getOpsMetrics(prisma: PrismaClient, now = new Date()): Promise<OpsMetric[]> {
  const [lead, zero, revert, repurchase, manual] = await Promise.all([
    judgmentLeadTime(prisma),
    zeroPurchaseRate(prisma, now),
    judgmentRevertRate(prisma),
    repurchaseAfterJudgment(prisma),
    manualInterventions(prisma),
  ]);

  const per100 = manual.judged === 0 ? 0 : (manual.total / manual.judged) * 100;

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
      key: 'revertRate',
      label: '되돌린 판정',
      value: pct(revert.reverted, revert.judged),
      sample: `전체 판정 ${revert.judged}건 중 ${revert.reverted}건 (이의제기 창구가 없어 실제보다 낮게 나옵니다)`,
      meaning:
        '올라가면 시세 데이터(배당락·수정주가)가 판정 로직을 부수고 있을 확률이 높습니다.',
      alert:
        revert.judged > 0 && revert.reverted / revert.judged > OPS_THRESHOLDS.revertRate,
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
