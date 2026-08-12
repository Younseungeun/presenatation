import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { stabilityLevel } from '../src/domain/stability';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { fetchRealizedSigma } from '../src/server/realizedVolatility';

// 일회성 백필 — sigmaDaily 컬럼 도입(2026-08-12) 이전에 게시된 카드의 실현 변동성 채우기.
// 이후 카드는 게시 시점(finalizePublish)에 자동으로 잰다.
//
// 종목 단위로 한 번만 조회한다 — KIS는 초당 1회 제한이라 카드 단위로 돌면
// 같은 종목을 여러 번 부르며 시간만 쓴다. 실패한 종목은 null로 남긴다(별점 "—").

async function main() {
  const prisma = new PrismaClient();
  const registry = createDefaultRegistry();

  const cards = await prisma.predictionCard.findMany({
    where: { sigmaDaily: null },
    select: { id: true, assetClass: true, ticker: true },
  });
  console.log(`sigmaDaily 없는 카드 ${cards.length}장`);

  const byInstrument = new Map<string, { assetClass: AssetClass; ticker: string; ids: string[] }>();
  for (const c of cards) {
    const key = `${c.assetClass}:${c.ticker}`;
    const entry =
      byInstrument.get(key) ??
      ({ assetClass: c.assetClass as AssetClass, ticker: c.ticker, ids: [] });
    entry.ids.push(c.id);
    byInstrument.set(key, entry);
  }
  console.log(`종목 ${byInstrument.size}개 조회 시작`);

  let filled = 0;
  let failed = 0;
  for (const { assetClass, ticker, ids } of byInstrument.values()) {
    const sigma = await fetchRealizedSigma(registry, assetClass, ticker);
    if (sigma === null) {
      failed++;
      console.log(`  ✗ ${assetClass} ${ticker}: σ 산출 실패 (카드 ${ids.length}장 "—" 유지)`);
      continue;
    }
    await prisma.predictionCard.updateMany({
      where: { id: { in: ids } },
      data: { sigmaDaily: sigma },
    });
    // 같은 측정으로 종목 캐시도 채운다 — 작성 화면이 이 종목을 고를 때 시세를 다시
    // 부르지 않게 (한 번 재서 여러 곳이 읽는다는 원칙, server/instrumentSigma.ts)
    await prisma.instrument.updateMany({
      where: { assetClass, ticker },
      data: { sigmaDaily: sigma, sigmaSyncedAt: new Date() },
    });
    filled += ids.length;
    console.log(
      `  ✓ ${assetClass} ${ticker}: σ=${(sigma * 100).toFixed(2)}%/일 → 안정성 ★${stabilityLevel(sigma)} (카드 ${ids.length}장)`,
    );
  }

  console.log(`완료 — 채움 ${filled}장 / 실패 종목 ${failed}개`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
