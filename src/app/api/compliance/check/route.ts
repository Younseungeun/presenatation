import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { ASSET_CLASSES } from '@/domain/constants';
import { RISK_LEVELS } from '@/domain/instrumentRisk';
import { REPORT_TEXT_LIMITS } from '@/domain/publishReport';
import { createEmbeddingProviderFromEnv } from '@/infra/embedding/provider';
import {
  createStudentClientFromEnv,
  studentMode,
} from '@/infra/compliance/studentClient';
import { prisma } from '@/server/db';
import {
  collectAutoScreenFindings,
  getCategoryOutcomeRates,
} from '@/server/complianceService';
import { getKnownInstrumentNames } from '@/server/instrumentNames';
import { getActiveLearnedPhrases } from '@/server/learnedPhraseService';
import { loadSemanticIndex } from '@/server/semanticIndexService';
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

    const [phrases, categoryRates, knownNames] = await Promise.all([
      getActiveLearnedPhrases(prisma),
      getCategoryOutcomeRates(prisma),
      getKnownInstrumentNames(prisma),
    ]);

    // **게시 검수와 같은 함수로 조립한다** (8차 E-6). 예전에는 여기서 따로 이어 붙였는데,
    // 그러면 한쪽에만 탐지기를 더하는 날 화면과 실제 결과가 갈라진다 — 리서처는
    // "소견 없음"을 보고 제출했다가 보류를 맞는다. 조립은 collectAutoScreenFindings 한 곳에만.
    //
    // **학생은 작성 중 검사에서 뺀다** (Q10 · 2026-08-21). 두 이유:
    //   ① 부하 — 디바운스 600ms 면 리포트 한 건 쓰는 동안 사이드카를 수십 번 부른다.
    //     게시 시 1회와 자릿수가 다르다. 사전 검사의 설계 근거가 "AI 호출 없이 비용 ≈ 0"
    //     이었는데 학생 호출이 슬쩍 들어와 그 전제를 깨고 있었다
    //   ② 화면 문구가 이미 정직하다 — "명백한 금지 표현은 없습니다"까지만 말하고
    //     통과를 보장하지 않는다. 학생 몫의 판단은 게시 시점에 돈다
    const { all: findings } = await collectAutoScreenFindings(input, {
      phrases,
      knownNames,
    });

    // **검사기 장애를 화면에 알린다** (Q10-거짓말 문제). 라이브 학생이 죽어 있으면
    // 게시가 보류될 것이므로, 작성 화면이 그 사실을 말해야 리서처가 통과를 예상하고
    // 냈다가 보류를 맞지 않는다. usable() 은 결과를 캐시하므로 타자마다 새 호출이
    // 나가지 않는다.
    const student = studentMode() === 'live' ? createStudentClientFromEnv() : null;
    const studentDown = student ? !(await student.usable()) : false;

    return NextResponse.json({ findings, categoryRates, studentDown });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
