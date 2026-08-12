import type { PrismaClient } from '@prisma/client';
import type { AssetClass } from '@/domain/constants';
import type { ProviderRegistry } from '@/domain/marketData';
import { captureBaseAnchor } from './corporateActionService';
import { getInstrumentSigma } from './instrumentSigma';

// 게시 때 못 채운 값을 나중에 메운다 (σ·분할 감지 앵커).
//
// 왜 필요한가: 둘 다 게시 시점에 시세를 불러 채우는데, **실패해도 게시는 진행된다**
// (별점은 부가 정보이고 앵커는 감지 수단일 뿐이라 게시를 막지 않는 게 맞다).
// 그런데 그렇게 비어 버린 카드는 아무도 다시 채워 주지 않아서, 한 번의 일시적
// 시세 장애가 그 카드의 안정성 별점을 판정 때까지 "—"로 남기고 분할 감지도 못 하게 한다.
//
// 하루 한 번, **비어 있는 미판정 카드만** 채운다. 종목 단위로 묶어 같은 종목은
// 한 번만 조회하고, 한 회차 처리량에 상한을 둔다(초당 1회 제한에서 배치가 길어지지 않게).

export interface HealSummary {
  sigmaFilled: number;
  anchorFilled: number;
  failed: number;
}

export async function healMissingCardData(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
  limit = 20,
): Promise<HealSummary> {
  const cards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      withdrawnAt: null,
      deadline: { gt: now },
      report: { status: 'PUBLISHED', publishedAt: { not: null } },
      OR: [{ sigmaDaily: null }, { baseCloseAnchor: null }],
    },
    select: {
      id: true,
      assetClass: true,
      ticker: true,
      sigmaDaily: true,
      baseCloseAnchor: true,
      report: { select: { publishedAt: true } },
    },
    take: limit,
  });

  const summary: HealSummary = { sigmaFilled: 0, anchorFilled: 0, failed: 0 };

  for (const card of cards) {
    const assetClass = card.assetClass as AssetClass;
    try {
      const data: { sigmaDaily?: number; baseCloseAnchor?: number; baseCloseAnchorDate?: string } =
        {};

      if (card.sigmaDaily == null) {
        // 종목 캐시를 쓰므로 같은 종목이 여러 장이어도 조회는 한 번이다
        const sigma = await getInstrumentSigma(prisma, registry, assetClass, card.ticker, now);
        if (sigma !== null) {
          data.sigmaDaily = sigma;
          summary.sigmaFilled++;
        }
      }

      if (card.baseCloseAnchor == null) {
        // **게시 시점 기준으로 잡는다** — 지금 종가로 잡으면 그 사이의 권리 사건을
        // 놓친 채 "사건 없음"으로 굳어진다 (백필 스크립트와 같은 한계·같은 규칙)
        const anchor = await captureBaseAnchor(
          registry,
          assetClass,
          card.ticker,
          card.report.publishedAt ?? now,
        );
        if (anchor) {
          data.baseCloseAnchor = anchor.close;
          data.baseCloseAnchorDate = anchor.date;
          summary.anchorFilled++;
        }
      }

      if (Object.keys(data).length > 0) {
        await prisma.predictionCard.update({ where: { id: card.id }, data });
      }
    } catch {
      summary.failed++;
    }
  }

  return summary;
}
