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
//  · 에스크로 보관액    → 요청에 따라 포함하되 금액 토글로 분리 (아래 주석)
//
// 뺀 것
//  · **전체 적중률** — 넣지 않는다. 높으면 플랫폼이 "예측이 잘 맞는다"고 홍보하는 모양이
//    되어 투자권유 소지가 생기고(기획 §1 법적 경계), 낮으면 그 자체로 서비스를 부정한다.
//    적중률은 리서처 개인의 트랙레코드일 때만 뜻이 있다 — 플랫폼 평균은 아무것도 말하지 않는다.
//  · 거래액(GMV) — 플랫폼 매출 규모는 구매자에게 쓸모가 없고, 초기 수치는 작아서 해롭다.

export interface MarketStat {
  key: string;
  label: string;
  value: string;
  /** 금액 항목인지 — 운영자가 금액만 따로 끌 수 있다 */
  isAmount: boolean;
}

const DAY_MS = 86_400_000;

/** 금액 표기 — 억·만 단위로 접는다. 돈은 자릿수가 길어 그대로 두면 띠지에서 안 읽힌다 */
export function formatKrw(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}억원`;
  if (n >= 10_000) return `${Math.round(n / 10_000).toLocaleString()}만원`;
  return `${n.toLocaleString()}원`;
}

/**
 * 띠지용 집계. 전부 단순 count/sum이라 인덱스만 있으면 가볍다.
 * 수치가 0인 항목은 아예 빼서 "0장"이 흐르지 않게 한다 —
 * 빈 마켓을 광고하는 것보다 그 줄을 없애는 편이 정직하고 낫다.
 */
export async function getMarketStats(
  prisma: PrismaClient,
  opts: { includeAmounts: boolean },
  now = new Date(),
): Promise<MarketStat[]> {
  const todayStart = new Date(now.getTime() - DAY_MS);

  const [verifying, judged, researchers, freshCards, refunded, escrow] = await Promise.all([
    // 검증 중 = 게시됐고 시한 전이며 철회되지 않은 카드
    prisma.predictionCard.count({
      where: {
        withdrawnAt: null,
        judgment: { is: null },
        deadline: { gt: now },
        report: { status: 'PUBLISHED' },
      },
    }),
    prisma.judgment.count(),
    // 활동 리서처 = 게시한 리포트가 하나라도 있는 사람
    prisma.researcherProfile.count({ where: { reports: { some: { status: 'PUBLISHED' } } } }),
    prisma.report.count({
      where: { status: 'PUBLISHED', publishedAt: { gte: todayStart } },
    }),
    opts.includeAmounts
      ? prisma.settlement.aggregate({ _sum: { buyerRefundKrw: true } })
      : Promise.resolve(null),
    opts.includeAmounts
      ? prisma.purchase.aggregate({
          where: { escrowStatus: 'HELD' },
          _sum: { amountKrw: true },
        })
      : Promise.resolve(null),
  ]);

  // raw를 함께 들고 다닌다 — 0 걸러내기를 포맷된 문자열로 판단하면
  // 표기가 바뀔 때마다 조용히 깨진다
  const rows: Array<MarketStat & { raw: number }> = [
    { key: 'verifying', label: '검증 중인 예측 카드', value: `${verifying.toLocaleString()}장`, isAmount: false, raw: verifying },
    { key: 'judged', label: '지금까지 자동 판정', value: `${judged.toLocaleString()}건`, isAmount: false, raw: judged },
    { key: 'researchers', label: '활동 중인 리서처', value: `${researchers.toLocaleString()}명`, isAmount: false, raw: researchers },
    { key: 'fresh', label: '최근 24시간 새 카드', value: `${freshCards.toLocaleString()}장`, isAmount: false, raw: freshCards },
  ];

  if (opts.includeAmounts) {
    // 누적 환불이 이 목록에서 가장 강한 숫자다 — "틀리면 환불"이 집행된다는 증거
    const refundSum = refunded?._sum.buyerRefundKrw ?? 0;
    const escrowSum = escrow?._sum.amountKrw ?? 0;
    rows.push({ key: 'refunded', label: '누적 현금 환불', value: formatKrw(refundSum), isAmount: true, raw: refundSum });
    rows.push({ key: 'escrow', label: '에스크로 보관 중', value: formatKrw(escrowSum), isAmount: true, raw: escrowSum });
  }

  // 0인 항목은 흐르지 않는다. 빈 마켓을 광고하는 것보다 그 줄을 없애는 편이 정직하고 낫다
  return rows
    .filter((r) => r.raw > 0)
    .map((r) => ({ key: r.key, label: r.label, value: r.value, isAmount: r.isAmount }));
}
