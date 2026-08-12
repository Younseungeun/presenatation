import type { PrismaClient } from '@prisma/client';
import {
  isSalesWindowOpen,
  salesWindowEnd,
  type SalesCloseReason,
} from '@/domain/salesWindow';

// 판매 마감 배치 — 하루 1회 이상 (npm run batch:salesclose).
//
// 여기서 닫는 것은 **판매**이지 카드가 아니다: 카드는 살아서 판정되고,
// 기존 구매자·히트맵·컨센서스는 아무 영향이 없다.
//
// ── 2026-08-10 재설계: 이 배치는 이제 **시간 규칙(WINDOW_END)만** 집행한다 ──
// 가격 때문에 판매가 영구히 닫히는 일은 없다 (구 BAND_EXIT 폐지):
//   · 목표 도달(일봉 종가) → **판정**이 일어나고, 판정된 카드는 팔 수 없으므로
//     판매도 그 순간 끝난다 — 도달 판정 배치(reachedJudgmentBatch)의 몫이다
//   · 가격 괴리 → 결제 관문의 **가역적 판매 중단**(purchaseService, q < 1/2)이 막는다.
//     시세가 돌아오면 다시 팔린다 — 순간 꼬리로 남의 판매를 죽이는 조작이 성립하지 않는다
// 그래서 이 배치는 시세를 전혀 조회하지 않는다.
//
// 시간 규칙 자체는 관문들이 계산으로 즉시 집행한다(isSalesWindowOpen) — 이 배치의
// 역할은 집행이 아니라 **기록**(salesClosedAt·사유)과 **리서처 알림**이다.

/** 리서처에게만 가는 사유 안내 — 구매자에게는 사유 없이 "판매 마감" 한 줄이다 */
const CLOSE_NOTICE: Record<SalesCloseReason, string> = {
  WINDOW_END:
    '판매 기간(검증 기간의 1/3, 최대 30일)이 끝나 판매가 마감되었습니다. 카드는 그대로 검증되어 판정됩니다.',
  RESEARCHER:
    '요청하신 대로 판매를 마감했습니다. 다시 열 수 없습니다. 카드는 그대로 검증되어 판정되고, 기존 구매자의 환불 조건도 변하지 않습니다.',
};

export interface SalesCloseResult {
  checked: number;
  closed: { reportId: string; reason: SalesCloseReason }[];
}

export async function runSalesCloseBatch(
  prisma: PrismaClient,
  now = new Date(),
): Promise<SalesCloseResult> {
  const candidates = await prisma.report.findMany({
    where: {
      status: 'PUBLISHED',
      salesClosedAt: null,
      predictionCard: { is: { deadline: { gt: now }, withdrawnAt: null, judgment: null } },
    },
    select: {
      id: true,
      publishedAt: true,
      researcher: { select: { userId: true } },
      predictionCard: { select: { deadline: true } },
    },
  });

  const result: SalesCloseResult = { checked: candidates.length, closed: [] };

  for (const r of candidates) {
    if (r.publishedAt && now >= salesWindowEnd(r.publishedAt, r.predictionCard!.deadline)) {
      await closeSales(prisma, r.id, r.researcher.userId, 'WINDOW_END', now);
      result.closed.push({ reportId: r.id, reason: 'WINDOW_END' });
    }
  }

  return result;
}

/**
 * 리서처 자발 판매 단축 — 본인이 판매를 일찍 닫는다. **회수 불가.**
 *
 * 촉매형 리포트(실적 발표·이벤트 직전)는 논지가 소비되는 시점이 정해져 있는데
 * 시스템의 1/3 규칙은 그 시점을 모른다. 촉매가 지난 뒤에도 계속 팔리면
 * "이미 끝난 논지를 판 사람"이 되어 평판이 깎인다.
 *
 * **되돌릴 수 없게 만든 것이 이 기능의 핵심이다.** 판매 수익을 스스로 포기하는 행위라
 * 실력 없는 사람은 흉내낼 이유가 없는 정직 신호인데, 재개가 가능하면 비용이 0이 되어
 * 신호가 죽는다(닫았다 열었다 하며 희소성만 연출하게 된다).
 *
 * 사유는 구매자에게 공개하지 않는다 — 다른 마감과 똑같이 "판매 마감" 한 줄이다.
 * "리서처가 직접 닫았다"가 보이면 촉매 임박 신호가 되어 종목 역산을 돕는다.
 */
export async function closeSalesByResearcher(
  prisma: PrismaClient,
  reportId: string,
  requesterUserId: string,
  now = new Date(),
): Promise<void> {
  const report = await prisma.report.findUniqueOrThrow({
    where: { id: reportId },
    select: {
      status: true,
      publishedAt: true,
      salesClosedAt: true,
      researcher: { select: { userId: true } },
      predictionCard: { select: { deadline: true, withdrawnAt: true } },
    },
  });

  if (report.researcher.userId !== requesterUserId) {
    throw new Error('본인이 쓴 리포트만 판매를 마감할 수 있습니다');
  }
  if (report.status !== 'PUBLISHED') {
    throw new Error('판매 중인 리포트가 아닙니다');
  }
  if (!report.predictionCard || report.predictionCard.withdrawnAt) {
    throw new Error('예측 카드가 없거나 철회된 리포트입니다');
  }
  if (report.salesClosedAt) {
    throw new Error('이미 판매가 마감된 리포트입니다');
  }
  // 시스템 규칙으로 이미 닫혀 있어야 할 카드에 "리서처가 닫았다"를 덧씌우지 않는다 —
  // 기록이 사실과 달라지면 나중에 정직 신호를 집계할 때 셈이 틀린다
  if (!isSalesWindowOpen(report.publishedAt, report.predictionCard.deadline, now)) {
    throw new Error('판매 기간이 이미 끝난 리포트입니다');
  }

  await closeSales(prisma, reportId, report.researcher.userId, 'RESEARCHER', now);
}

async function closeSales(
  prisma: PrismaClient,
  reportId: string,
  researcherUserId: string,
  reason: SalesCloseReason,
  now: Date,
): Promise<void> {
  await prisma.$transaction([
    prisma.report.update({
      where: { id: reportId },
      data: { salesClosedAt: now, salesCloseReason: reason },
    }),
    // 리서처 통지 — 왜 안 팔리는지 몰라야 할 이유가 없다.
    // 사유 상세는 본인에게만 간다(목록·상세의 공개 문구는 "판매 마감" 하나로 통일)
    prisma.notification.create({
      data: {
        userId: researcherUserId,
        type: 'SALES_CLOSED',
        title: '카드 판매가 마감되었습니다',
        body: CLOSE_NOTICE[reason],
        link: `/report/${reportId}`,
      },
    }),
  ]);
}
