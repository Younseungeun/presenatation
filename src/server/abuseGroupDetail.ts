import type { PrismaClient } from '@prisma/client';
import { applyRules, type Finding } from '@/domain/compliance';
import { getActiveLearnedPhrases } from './learnedPhraseService';
import { magnitudePctToTargetPrice, targetPriceToMagnitudePct } from '@/domain/scoring';
import { TIER_NAME, type Tier } from '@/domain/constants';

/**
 * 신고 건 하나를 판단하는 데 필요한 재료 — **목록이 아니라 펼친 뒤에만 부른다.**
 *
 * 목록은 "무엇이 얼마나 급한가"까지만 답하면 되고, 여기 있는 것들(본문 전체·규칙 재검사·
 * 판매 건수)은 그 질문에 필요 없다. 목록에서 다 실어 오면 신고 20건일 때 리포트 20개의
 * 본문을 매번 읽는다.
 */

export type AbuseGroupDetail = {
  reportId: string;
  title: string;
  summary: string;
  body: string;
  publishedAt: Date | null;
  researcherName: string;
  tierLabel: string;
  salesCount: number;
  /** 신고된 본문을 규칙에 **다시 걸어 본 결과** — 아래 주석 참조 */
  flagged: Finding[];
  card: {
    assetName: string;
    ticker: string;
    assetClassLabel: string;
    direction: 'UP' | 'DOWN';
    /** 목표가·기준가의 통화 — 미국주식을 '원'으로 적으면 그 자체가 거짓말이다 */
    currency: string;
    /** 크기(%) — 목표가형이면 기준가 대비로 환산한 값 */
    magnitudePct: number | null;
    basePrice: number | null;
    targetPrice: number | null;
    deadline: Date | null;
  } | null;
};

const ASSET_CLASS_LABEL: Record<string, string> = {
  KR_EQUITY: '국내주식',
  US_EQUITY: '미국주식',
  CRYPTO: '코인',
};

/**
 * 카드가 말한 주장을 **가격으로** 옮긴다 — 구매자가 산 것은 "12%"가 아니라
 * "71,000원이 79,520원까지"이고, 화면이 보여준 것도 그쪽이다.
 * 환산은 domain/scoring의 두 함수(서로의 역)만 쓴다 — 여기서 곱셈을 하면
 * 화면이 말한 목표가와 채점이 쓴 크기가 갈라진다.
 */
function toCardView(card: {
  assetClass: string;
  assetName: string;
  ticker: string;
  currency: string;
  direction: string;
  targetType: string;
  targetValue: number;
  basePrice: number | null;
  deadline: Date;
}) {
  const direction = card.direction as 'UP' | 'DOWN';
  const isPct = card.targetType === 'RETURN_PCT';
  const magnitudePct = isPct
    ? card.targetValue
    : card.basePrice === null || card.basePrice <= 0
      ? null
      : targetPriceToMagnitudePct(card.targetValue, card.basePrice);
  const targetPrice = isPct
    ? card.basePrice === null || card.basePrice <= 0
      ? null
      : magnitudePctToTargetPrice(card.basePrice, direction, card.targetValue)
    : card.targetValue;
  return {
    assetName: card.assetName,
    ticker: card.ticker,
    assetClassLabel: ASSET_CLASS_LABEL[card.assetClass] ?? card.assetClass,
    currency: card.currency,
    direction,
    magnitudePct,
    basePrice: card.basePrice,
    targetPrice,
    deadline: card.deadline,
  };
}

export async function getAbuseGroupDetail(
  prisma: PrismaClient,
  reportId: string,
): Promise<AbuseGroupDetail | null> {
  const r = await prisma.report.findUnique({
    where: { id: reportId },
    select: {
      id: true,
      title: true,
      summary: true,
      content: true,
      publishedAt: true,
      researcher: {
        select: { tier: true, user: { select: { penName: true, email: true } } },
      },
      predictionCard: {
        select: {
          assetClass: true,
          assetName: true,
          ticker: true,
          currency: true,
          direction: true,
          targetType: true,
          targetValue: true,
          basePrice: true,
          deadline: true,
        },
      },
      _count: { select: { purchases: true } },
    },
  });
  if (!r) return null;

  const card = r.predictionCard;

  /**
   * **신고된 글을 규칙에 다시 걸어 본다.**
   *
   * 신고자가 남긴 것은 "어디가 문제인지"에 대한 자기 말이지 본문의 인용이 아니다.
   * 운영자가 정작 봐야 하는 것은 **본문의 어느 문장**인데, 이 글은 게시될 때 검수를
   * 통과했으므로 저장된 소견도 없다. 그래서 지금 다시 건다 — 그 사이 학습 표현이
   * 늘었으면 이번에는 걸리고, 그게 곧 "검수가 놓친 것"의 정체다.
   *
   * 안 걸리는 것도 답이다: 규칙이 못 잡는 종류라는 뜻이고, 그러면 운영자가 본문을
   * 직접 읽어야 한다. 없는 인용을 지어내지 않는다.
   */
  const input = {
    title: r.title,
    summary: r.summary,
    content: r.content,
    assetClass: (card?.assetClass ?? 'KR_EQUITY') as never,
    assetName: card?.assetName ?? '',
    direction: (card?.direction ?? 'UP') as 'UP' | 'DOWN',
  };
  // 사전은 규칙 엔진의 입력이다 (20차) — 같은 6층·같은 가드를 지난다
  const phrases = await getActiveLearnedPhrases(prisma);
  const flagged = applyRules(input, { phrases });

  return {
    reportId: r.id,
    title: r.title,
    summary: r.summary,
    body: r.content,
    publishedAt: r.publishedAt,
    researcherName: r.researcher.user.penName ?? r.researcher.user.email,
    tierLabel: TIER_NAME[r.researcher.tier as Tier] ?? r.researcher.tier,
    salesCount: r._count.purchases,
    flagged,
    card: card ? toCardView(card) : null,
  };
}
