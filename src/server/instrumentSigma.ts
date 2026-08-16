import type { PrismaClient } from '@prisma/client';
import type { AssetClass } from '@/domain/constants';
import type { ProviderRegistry } from '@/domain/marketData';
import { fetchRealizedSigmaResult, type SigmaResult } from './realizedVolatility';

// 종목 실현 변동성 조회 — **한 번 재서 두 곳이 읽는다.**
//   · 안정성 별점 (domain/stability.ts)
//   · 무정보 도달 확률 p₀ (domain/scoring.ts) — 변동성만으로 hit을 노리는 길을 닫는 값
//
// 캐시가 필요한 이유: 작성 화면은 리서처가 종목을 고르는 **그 순간** σ를 보여줘야
// 하는데(그래야 정직한 신뢰도를 그 자리에서 판단한다), KIS는 초당 1회 제한이라
// 매번 재면 화면이 멈춘다. 하루 한 번이면 충분하다 — 120거래일 표본의 σ는
// 하루 사이에 눈에 띄게 변하지 않는다.
//
// **게시 시점 값은 이 캐시가 아니라 카드가 따로 고정한다** (reportService.finalizePublish).
// 캐시를 그대로 쓰면 종목 σ가 갱신될 때 이미 게시된 카드의 채점 기준이 함께 흔들린다.

const CACHE_TTL_MS = 24 * 60 * 60_000;

/**
 * 캐시된 σ와, 못 냈으면 그 이유 (없거나 오래됐으면 실측 후 갱신).
 *
 * 게시 관문이 이 함수를 쓴다 — `INSUFFICIENT_SAMPLES`면 게시를 막아야 하는데,
 * `null` 하나로 뭉개면 일시 장애와 구별되지 않는다(realizedVolatility.SigmaFailure).
 */
export async function getInstrumentSigmaResult(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  assetClass: AssetClass,
  ticker: string,
  now = new Date(),
): Promise<SigmaResult> {
  const row = await prisma.instrument.findUnique({
    where: { assetClass_ticker: { assetClass, ticker } },
    select: { sigmaDaily: true, sigmaSyncedAt: true },
  });

  const fresh =
    row?.sigmaSyncedAt != null && now.getTime() - row.sigmaSyncedAt.getTime() < CACHE_TTL_MS;
  if (fresh && row?.sigmaDaily != null) return { sigma: row.sigmaDaily };

  const measured = await fetchRealizedSigmaResult(registry, assetClass, ticker, now);
  if (measured.sigma === null) {
    // 실패를 캐시하지 않는다 — 다음 요청이 다시 시도해야 일시 장애가 하루 동안 굳지 않는다.
    //
    // **낡은 캐시값이 있으면 그것을 쓴다.** 한 번이라도 잰 적이 있다는 것은 그 종목에
    // 표본이 충분했다는 뜻이므로, 지금 못 쟀다면 그건 표본 문제가 아니라 장애다 —
    // 이 경우 이유를 `UNAVAILABLE`로 덮어써야 게시가 잘못 막히지 않는다.
    if (row?.sigmaDaily != null) return { sigma: row.sigmaDaily };
    return measured;
  }

  await prisma.instrument.updateMany({
    where: { assetClass, ticker },
    data: { sigmaDaily: measured.sigma, sigmaSyncedAt: now },
  });
  return measured;
}

/**
 * 캐시된 σ (없거나 오래됐으면 실측 후 갱신).
 * 못 냈으면 null — 화면은 "아직 못 쟀다"고 말한다. 이유가 필요하면 위 함수를 쓴다.
 */
export async function getInstrumentSigma(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  assetClass: AssetClass,
  ticker: string,
  now = new Date(),
): Promise<number | null> {
  return (await getInstrumentSigmaResult(prisma, registry, assetClass, ticker, now)).sigma;
}
