import type { PrismaClient } from '@prisma/client';

// 시장 규모 띠지에 흐르는 숫자들.
//
// 무엇을 넣고 무엇을 뺐는지가 이 파일의 핵심이다. 기준은 하나 —
// **이 서비스가 한 약속이 실제로 지켜지고 있다는 증거인가.**
//
// 넣은 것
//  · 검증 중인 카드    → 지금 시장이 돌아가고 있다
//  · 누적 자동 판정     → "시장 데이터가 채점한다"는 약속이 실제로 집행됐다 (핵심 증거)
//  · 누적 현금 환불     → "틀리면 환불"이 말이 아니라 집행이다 (가장 강력한 증거)
//  · 활동 리서처       → 공급 규모
//  · 오늘 올라온 카드   → 신선도. 어제 죽은 마켓이 아니라는 표시
//  · 에스크로 보관액    → 요청에 따라 포함하되 금액 토글로 분리
//
// 뺀 것
//  · **전체 적중률** — 넣지 않는다. 높으면 플랫폼이 "예측이 잘 맞는다"고 홍보하는 모양이
//    되어 투자권유 소지가 생기고(기획 §1 법적 경계), 낮으면 그 자체로 서비스를 부정한다.
//    적중률은 리서처 개인의 트랙레코드일 때만 뜻이 있다 — 플랫폼 평균은 아무것도 말하지 않는다.
//  · 거래액(GMV) — 플랫폼 매출 규모는 구매자에게 쓸모가 없고, 초기 수치는 작아서 해롭다.
//
// ── 증감 표시 ────────────────────────────────────────────────────────
// 값 옆의 (+3)은 "지금 값 − 과거 값"이다. 과거 값은 지금 조회로 알 수 없어
// (검증 중 카드 수처럼 오르내리는 값은 복원 자체가 불가능하다) 매시간 스냅샷을 찍어 둔다.
// 비교 기준은 **24시간 전**이다 — 1시간 전과 견주면 대부분 0이라 죽은 마켓처럼 보이고,
// 띠지가 답해야 할 질문은 "오늘 하루 이 마켓이 얼마나 컸나"이기 때문이다.

/**
 * 증감. 방향을 문자열에서 다시 읽지 않도록 값으로 들고 다닌다
 * ("+로 시작하면 상승"식 판별은 표기를 바꾸는 순간 조용히 깨진다).
 */
export interface MarketDelta {
  up: boolean;
  /** 부호 없는 크기 — 방향은 화살표가 말한다 */
  amount: string;
}

export interface MarketStat {
  key: string;
  label: string;
  value: string;
  /** 24시간 전 대비 증감. 변화가 없거나 비교 기준이 없으면 null (0을 적는 것은 잡음이다) */
  delta: MarketDelta | null;
  /** 금액 항목인지 — 운영자가 금액만 따로 끌 수 있다 */
  isAmount: boolean;
}

const DAY_MS = 86_400_000;
/** 증감 비교 창 — 하루. 1시간 전과 견주면 대부분 0이라 죽은 마켓처럼 보인다 */
export const DELTA_WINDOW_MS = DAY_MS;

/** 금액 표기 — 억·만 단위로 접는다. 돈은 자릿수가 길어 그대로 두면 띠지에서 안 읽힌다 */
export function formatKrw(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억원`;
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString()}만원`;
  return `${n.toLocaleString()}원`;
}

/**
 * 증감 — 0이면 null. "0"을 적는 것은 정보가 아니라 잡음이다.
 * 부호는 붙이지 않는다: 화면이 화살표로 방향을 말하므로 +/−를 함께 쓰면 같은 말이 두 번이다.
 */
export function formatDelta(diff: number, isAmount: boolean): MarketDelta | null {
  if (diff === 0) return null;
  const size = Math.abs(diff);
  return {
    up: diff > 0,
    amount: isAmount ? formatKrw(size) : size.toLocaleString(),
  };
}

/** 스냅샷에 담기는 원시 수치 — 화면 표기와 분리해 둔다 */
export interface MarketNumbers {
  verifying: number;
  judged: number;
  researchers: number;
  refundedKrw: number;
  escrowKrw: number;
}

/** 지금 시점의 원시 수치. 스냅샷 배치와 띠지가 같은 함수를 쓴다 — 정의가 갈라지면 증감이 거짓말을 한다 */
export async function collectMarketNumbers(
  prisma: PrismaClient,
  now = new Date(),
): Promise<MarketNumbers> {
  const [verifying, judged, researchers, refunded, escrow] = await Promise.all([
    prisma.predictionCard.count({
      where: {
        withdrawnAt: null,
        judgment: { is: null },
        deadline: { gt: now },
        report: { status: 'PUBLISHED' },
      },
    }),
    prisma.judgment.count(),
    prisma.researcherProfile.count({ where: { reports: { some: { status: 'PUBLISHED' } } } }),
    prisma.settlement.aggregate({ _sum: { buyerRefundKrw: true } }),
    prisma.purchase.aggregate({
      where: { escrowStatus: 'HELD' },
      _sum: { amountKrw: true },
    }),
  ]);

  return {
    verifying,
    judged,
    researchers,
    refundedKrw: refunded._sum.buyerRefundKrw ?? 0,
    escrowKrw: escrow._sum.amountKrw ?? 0,
  };
}

/** 매시간 배치가 부른다 (npm run batch:snapshot) */
export async function takeMarketSnapshot(
  prisma: PrismaClient,
  now = new Date(),
): Promise<MarketNumbers> {
  const numbers = await collectMarketNumbers(prisma, now);
  await prisma.marketSnapshot.create({ data: { ...numbers, takenAt: now } });
  return numbers;
}

/**
 * 비교 기준 — 창(24시간) 이전에 찍힌 것 중 가장 최근 스냅샷.
 * 없으면 null: 기준이 없는데 지금 값을 증가분으로 적으면 "하루 만에 이만큼 컸다"는
 * 거짓말이 된다 (첫 스냅샷 직후가 특히 그렇다).
 */
async function baselineSnapshot(prisma: PrismaClient, now: Date) {
  return prisma.marketSnapshot.findFirst({
    where: { takenAt: { lte: new Date(now.getTime() - DELTA_WINDOW_MS) } },
    orderBy: { takenAt: 'desc' },
  });
}

/**
 * 띠지용 집계.
 * 수치가 0인 항목은 아예 빼서 "0장"이 흐르지 않게 한다 —
 * 빈 마켓을 광고하는 것보다 그 줄을 없애는 편이 정직하고 낫다.
 */
export async function getMarketStats(
  prisma: PrismaClient,
  opts: { includeAmounts: boolean },
  now = new Date(),
): Promise<MarketStat[]> {
  const todayStart = new Date(now.getTime() - DAY_MS);

  const [numbers, freshCards, baseline] = await Promise.all([
    collectMarketNumbers(prisma, now),
    prisma.report.count({
      where: { status: 'PUBLISHED', publishedAt: { gte: todayStart } },
    }),
    baselineSnapshot(prisma, now),
  ]);

  const delta = (current: number, past: number | undefined, isAmount: boolean) =>
    past === undefined ? null : formatDelta(current - past, isAmount);

  // raw를 함께 들고 다닌다 — 0 걸러내기를 포맷된 문자열로 판단하면
  // 표기가 바뀔 때마다 조용히 깨진다
  const rows: Array<MarketStat & { raw: number }> = [
    {
      key: 'verifying',
      label: '검증 중인 예측 카드',
      value: `${numbers.verifying.toLocaleString()}장`,
      delta: delta(numbers.verifying, baseline?.verifying, false),
      isAmount: false,
      raw: numbers.verifying,
    },
    {
      key: 'judged',
      label: '지금까지 자동 판정',
      value: `${numbers.judged.toLocaleString()}건`,
      delta: delta(numbers.judged, baseline?.judged, false),
      isAmount: false,
      raw: numbers.judged,
    },
    {
      key: 'researchers',
      label: '활동 중인 리서처',
      value: `${numbers.researchers.toLocaleString()}명`,
      delta: delta(numbers.researchers, baseline?.researchers, false),
      isAmount: false,
      raw: numbers.researchers,
    },
    {
      // 이 항목 자체가 이미 "24시간 동안의 증가분"이라 증감을 또 붙이지 않는다.
      // 증가분의 증가분은 읽는 사람이 해석할 수 없다
      key: 'fresh',
      label: '최근 24시간 새 카드',
      value: `${freshCards.toLocaleString()}장`,
      delta: null,
      isAmount: false,
      raw: freshCards,
    },
  ];

  if (opts.includeAmounts) {
    rows.push({
      key: 'refunded',
      label: '누적 현금 환불',
      value: formatKrw(numbers.refundedKrw),
      delta: delta(numbers.refundedKrw, baseline?.refundedKrw, true),
      isAmount: true,
      raw: numbers.refundedKrw,
    });
    rows.push({
      key: 'escrow',
      label: '에스크로 보관 중',
      value: formatKrw(numbers.escrowKrw),
      delta: delta(numbers.escrowKrw, baseline?.escrowKrw, true),
      isAmount: true,
      raw: numbers.escrowKrw,
    });
  }

  // 0인 항목은 흐르지 않는다. 빈 마켓을 광고하느니 그 줄을 없애는 편이 정직하다
  return rows
    .filter((r) => r.raw > 0)
    .map((r) => ({
      key: r.key,
      label: r.label,
      value: r.value,
      delta: r.delta,
      isAmount: r.isAmount,
    }));
}
