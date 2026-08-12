import type { PrismaClient } from '@prisma/client';
import type { AssetClass, TargetType } from '@/domain/constants';
import {
  describeFactor,
  detectAdjustment,
  rebase,
  ADJUSTMENT_EPSILON,
} from '@/domain/corporateAction';
import { resolveProvider, toMarketDateString, type ProviderRegistry } from '@/domain/marketData';

// 권리 사건(액면분할·병합·무상증자) 반영 — 판정·마감 배치가 카드마다 먼저 부른다.
//
// 왜 판정 전인가: 기준가가 옛 눈금에 남아 있으면 2:1 분할이 −50% 폭락으로 읽혀
// 실패 판정과 역방향 판매 마감이 **동시에** 잘못 일어난다. 고치는 일은 반드시
// 채점보다 앞서야 한다.
//
// 감지(앵커) → 교차검증(원주가 대조) → 반영(리베이스) → 기록 순서로 간다.
// 교차검증을 통과하지 못하면 **고치지 않고 기록만 남긴다** — 이미 팔린 상품의
// 조건을 바꾸는 일이라, 확신이 없을 때 손대지 않는 쪽이 안전하다.

/**
 * 게시 시점의 앵커 — 기준가와 함께 적어 두는 "그 거래일의 종가"와 날짜.
 * 게시일이 휴장이면 직전 거래일이 잡힌다(그 날짜를 그대로 저장하므로 나중 비교가 어긋나지 않는다).
 * 실패하면 null — 앵커가 없으면 분할 감지를 못 할 뿐, 게시를 막지는 않는다.
 */
export async function captureBaseAnchor(
  registry: ProviderRegistry,
  assetClass: AssetClass,
  ticker: string,
  now = new Date(),
): Promise<{ close: number; date: string } | null> {
  try {
    const provider = resolveProvider(registry, assetClass);
    const to = toMarketDateString(now, assetClass);
    const from = toMarketDateString(new Date(now.getTime() - 12 * 86_400_000), assetClass);
    const quotes = await provider.getDailyQuotes(ticker, from, to);
    const last = quotes[quotes.length - 1];
    return last && last.close > 0 ? { close: last.close, date: last.date } : null;
  } catch {
    return null;
  }
}

export interface RebaseTargetCard {
  id: string;
  ticker: string;
  assetClass: string;
  targetType: string;
  targetValue: number;
  basePrice: number | null;
  baseCloseAnchor: number | null;
  baseCloseAnchorDate: string | null;
}

export interface RebaseOutcome {
  factor: number;
  applied: boolean;
  basePrice: number;
  targetValue: number;
  note: string;
}

/**
 * 카드 하나를 점검해 필요하면 새 눈금으로 옮긴다.
 * 사건이 없거나 앵커가 없으면 null (대부분의 호출이 여기서 끝난다 — 조회도 하지 않는다).
 */
export async function rebaseIfAdjusted(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  card: RebaseTargetCard,
  now = new Date(),
): Promise<RebaseOutcome | null> {
  if (card.baseCloseAnchor == null || !card.baseCloseAnchorDate || card.basePrice == null) {
    return null;
  }
  const assetClass = card.assetClass as AssetClass;
  const provider = resolveProvider(registry, assetClass);
  const date = card.baseCloseAnchorDate;

  // **판정이 쓸 구간과 같은 범위로 부른다** — 앵커 하루치만 따로 부르면 종목 캐시
  // (memoizeRegistry)가 구간을 넓히며 조회를 한 번 더 하게 된다. 앵커일은 게시일
  // 근처이므로 [앵커일, 오늘]은 판정이 어차피 필요로 하는 구간이다
  const quotes = await provider.getDailyQuotes(
    card.ticker,
    date,
    toMarketDateString(now, assetClass),
  );
  const current = quotes.find((q) => q.date === date)?.close;
  if (current == null || !(current > 0)) return null;

  const detected = detectAdjustment(card.baseCloseAnchor, current);
  if (!detected) return null;

  // ── 교차검증: 원주가와 대조한다 ──────────────────────────────
  // 수정주가만 바뀌고 원주가는 그대로여야 권리 사건이다. 둘 다 바뀌었거나 배수가
  // 다르면 데이터 정정·오류이므로 자동 반영하지 않는다.
  let crossChecked: boolean | null = null;
  if (provider.getUnadjustedDailyQuotes) {
    try {
      const raw = await provider.getUnadjustedDailyQuotes(card.ticker, date, date);
      const rawClose = raw.find((q) => q.date === date)?.close;
      if (rawClose != null && rawClose > 0) {
        // 앵커는 게시 시점의 수정주가 = 그때의 원주가와 같아야 한다(사건 전이므로)
        const anchorMatchesRaw =
          Math.abs(rawClose / card.baseCloseAnchor - 1) <= ADJUSTMENT_EPSILON;
        const factorMatches = Math.abs(current / rawClose / detected.factor - 1) <= ADJUSTMENT_EPSILON;
        crossChecked = anchorMatchesRaw && factorMatches;
      }
    } catch {
      crossChecked = null; // 조회 실패는 "검증 실패"가 아니다 — 모른다
    }
  }

  const applied = detected.applicable && crossChecked !== false;
  const next = rebase(
    { basePrice: card.basePrice, targetType: card.targetType as TargetType, targetValue: card.targetValue },
    detected.factor,
  );
  const note = [
    describeFactor(detected.factor),
    crossChecked === true ? '원주가 대조 일치' : crossChecked === false ? '원주가 대조 불일치 — 미반영' : '원주가 대조 불가',
    detected.applicable ? null : '배수가 허용 범위 밖 — 미반영',
  ]
    .filter(Boolean)
    .join(' · ');

  await prisma.$transaction([
    ...(applied
      ? [
          prisma.predictionCard.update({
            where: { id: card.id },
            data: {
              basePrice: next.basePrice,
              targetValue: next.targetValue,
              // 앵커도 새 눈금으로 옮긴다 — 안 그러면 다음 회차에 같은 사건을 또 잡는다
              baseCloseAnchor: current,
            },
          }),
        ]
      : []),
    prisma.corporateActionLog.create({
      data: {
        predictionCardId: card.id,
        anchorDate: date,
        anchorBefore: card.baseCloseAnchor,
        anchorAfter: current,
        factor: detected.factor,
        basePriceBefore: card.basePrice,
        basePriceAfter: applied ? next.basePrice : card.basePrice,
        targetBefore: card.targetValue,
        targetAfter: applied ? next.targetValue : card.targetValue,
        applied,
        detectedAt: now,
      },
    }),
  ]);

  return {
    factor: detected.factor,
    applied,
    basePrice: applied ? next.basePrice : card.basePrice,
    targetValue: applied ? next.targetValue : card.targetValue,
    note,
  };
}
