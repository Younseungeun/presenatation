import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { toMarketDateString, resolveProvider } from '../src/domain/marketData';
import { createDefaultRegistry } from '../src/infra/marketData/registry';

// 일회성 백필 — 앵커 컬럼 도입(2026-08-12) 이전에 게시된 카드에 앵커를 채운다.
// 이후 카드는 게시 시점(finalizePublish)에 자동으로 남는다.
//
// **한계를 분명히 해 둔다**: 지금 조회하는 종가는 *이미 조정된* 값이라, 백필 이전에
// 일어난 분할은 잡을 수 없다(그 카드의 기준가는 이미 어긋난 채로 남는다). 백필은
// "이 시점부터의 사건을 감지할 수 있게" 하는 것이지 과거를 복원하지 않는다.
// 과거 사건이 의심되는 카드는 운영자가 수동 판정으로 처리한다.

async function main() {
  const prisma = new PrismaClient();
  const registry = createDefaultRegistry();

  const cards = await prisma.predictionCard.findMany({
    where: { baseCloseAnchor: null, judgment: null, report: { publishedAt: { not: null } } },
    select: {
      id: true,
      ticker: true,
      assetClass: true,
      report: { select: { publishedAt: true } },
    },
  });
  console.log(`앵커 없는 미판정 카드 ${cards.length}장`);

  let filled = 0;
  let failed = 0;
  for (const card of cards) {
    const assetClass = card.assetClass as AssetClass;
    try {
      const at = card.report.publishedAt!;
      const to = toMarketDateString(at, assetClass);
      const from = toMarketDateString(new Date(at.getTime() - 12 * 86_400_000), assetClass);
      const quotes = await resolveProvider(registry, assetClass).getDailyQuotes(
        card.ticker,
        from,
        to,
      );
      const last = quotes[quotes.length - 1];
      if (!last || !(last.close > 0)) {
        failed++;
        console.log(`  ✗ ${card.ticker}: 게시일 근처 일봉 없음`);
        continue;
      }
      await prisma.predictionCard.update({
        where: { id: card.id },
        data: { baseCloseAnchor: last.close, baseCloseAnchorDate: last.date },
      });
      filled++;
      console.log(`  ✓ ${card.ticker}: ${last.date} 종가 ${last.close}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${card.ticker}: ${(e as Error).message}`);
    }
  }

  console.log(`완료 — 채움 ${filled}장 / 실패 ${failed}장`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
