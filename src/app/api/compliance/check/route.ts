import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { applyRules, type Finding } from '@/domain/compliance';
import { ASSET_CLASSES } from '@/domain/constants';
import { RISK_LEVELS } from '@/domain/instrumentRisk';
import { matchLearnedPhrases } from '@/domain/learnedPhrases';
import { REPORT_TEXT_LIMITS } from '@/domain/publishReport';
import { createEmbeddingProviderFromEnv } from '@/infra/embedding/provider';
import { prisma } from '@/server/db';
import { getCategoryOutcomeRates } from '@/server/complianceService';
import { getActiveLearnedPhrases } from '@/server/learnedPhraseService';
import { findSemanticFindings, loadSemanticIndex } from '@/server/semanticIndexService';
import { requireResearcherId, toErrorResponse } from '../../_lib/http';

// 작성 중 사전 검사 — 리서처가 제출하기 전에 1차 검수 결과를 미리 보여준다.
//
// 왜 서버에서 도는가: 규칙을 브라우저 번들에 넣으면 금지 표현 목록과 학습 표현 사전이
// 그대로 공개된다. 검사 자체는 API 호출이 없는 순수 함수라 서버에서 돌려도 비용이
// 사실상 0이고, 대신 규칙은 비공개로 남는다.
//
// 이 응답은 **약속이 아니다**: 2차 AI 검수는 제출 시점에만 돌기 때문에
// "소견 없음"이 게시 보장을 뜻하지 않는다는 것을 호출자가 함께 표시해야 한다.

const bodySchema = z.object({
  title: z.string().max(REPORT_TEXT_LIMITS.title).default(''),
  summary: z.string().max(REPORT_TEXT_LIMITS.summary).default(''),
  content: z.string().max(REPORT_TEXT_LIMITS.content).default(''),
  assetClass: z.enum(ASSET_CLASSES),
  assetName: z.string().max(100).default(''),
  direction: z.enum(['UP', 'DOWN']).default('UP'),
  riskLevel: z.enum(RISK_LEVELS).optional(),
  riskNote: z.string().max(200).nullish(),
  delistingRisk: z.boolean().optional(),
  marketCap: z.number().nullish(),
  // 예측 카드 — 크기 상한 규칙이 여기서도 그대로 돌아야 작성 중에 알 수 있다
  targetType: z.enum(['TARGET_PRICE', 'RETURN_PCT']).optional(),
  magnitudePct: z.number().nullish(),
  horizonDays: z.number().nullish(),
  confidence: z.number().nullish(),
  // 크기의 현실성은 그 종목이 실제로 얼마나 움직이는지와 함께 봐야 한다
  sigmaDaily: z.number().nullish(),
});

export async function POST(req: NextRequest) {
  try {
    // 리서처 본인만 — 사전 검사를 열어두면 규칙을 밖에서 탐색할 수 있다
    await requireResearcherId(prisma);
    const input = bodySchema.parse(await req.json());

    const [phrases, categoryRates] = await Promise.all([
      getActiveLearnedPhrases(prisma),
      getCategoryOutcomeRates(prisma),
    ]);

    const phraseFindings = matchLearnedPhrases(input, phrases);
    // 의미 검색은 공급자가 있을 때만. 게시 시 검수와 같은 판단을 보여줘야
    // 화면과 실제 결과가 어긋나지 않는다.
    const embedder = createEmbeddingProviderFromEnv();
    const semanticFindings = embedder
      ? await findSemanticFindings(
          input,
          await loadSemanticIndex(prisma, embedder),
          embedder,
          phraseFindings.flatMap((f) => (f.phraseId ? [f.phraseId] : [])),
        ).catch(() => [])
      : [];

    const findings: Finding[] = [
      ...applyRules(input),
      ...phraseFindings,
      ...semanticFindings,
    ];

    return NextResponse.json({ findings, categoryRates });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
