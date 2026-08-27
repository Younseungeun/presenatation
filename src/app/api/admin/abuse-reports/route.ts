import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { RISK_CATEGORIES } from '@/domain/compliance';
import { validatePhrase } from '@/domain/learnedPhrases';
import { getAbuseReports, reviewAbuseReport } from '@/server/abuseReportService';
import { resolveAbuseReportGroup } from '@/server/abuseResolveService';
import { prisma } from '@/server/db';
import { createLearnedPhrase } from '@/server/learnedPhraseService';
import { storeTeacherPackForReport } from '@/server/teacherPackStore';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 신고 검토.
//
// 두 모양을 받는다:
//   · 그룹(reportId) — **표준 경로.** 확인이면 강제 철회·미탐 기록·학습 표현·신고자
//     전원 통지·보상까지 한 번에 (abuseResolveService). 판단 하나가 전부를 정한다
//   · 단건(id) — 리포트가 특정되지 않은 자유 입력 신고용. 내릴 상품이 없어 통지·기록만

const singleSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(['CONFIRMED', 'REJECTED']),
  note: z.string().min(1, '검토 사유를 적어 주세요').max(2000),
});

const groupSchema = z.object({
  reportId: z.string().min(1),
  decision: z.enum(['CONFIRMED', 'REJECTED']),
  note: z.string().min(1, '검토 사유를 적어 주세요').max(2000),
  category: z.enum(RISK_CATEGORIES).optional(),
  phrase: z.string().max(200).optional(),
  // 기각일 때만 의미 — "지적은 타당했다(경미)". 무고에서 빼고 경계 사례로 학습에 남긴다
  findingsValid: z.boolean().optional(),
});

/**
 * 확인과 함께 들어온 표현을 사전에 등록한다 — 컴플라이언스 라우트의 registerPhrase와
 * 같은 규칙: 표현이 잘못됐다고 확인을 되돌리지 않고, 실패 사유만 응답에 실어 준다.
 */
async function registerPhrase(
  operatorUserId: string,
  reportId: string,
  text: string | undefined,
  category: (typeof RISK_CATEGORIES)[number] | undefined,
  reason: string,
): Promise<{ phraseWarning: string | null; phraseCollisions: string[] }> {
  const none = { phraseWarning: null, phraseCollisions: [] as string[] };
  const trimmed = text?.trim();
  if (!trimmed) return none;
  if (!category) {
    return { ...none, phraseWarning: '표현을 등록하려면 실제 위반 유형을 골라 주세요' };
  }
  const issues = validatePhrase(trimmed);
  if (issues.length > 0) return { ...none, phraseWarning: issues.join(' / ') };
  const created = await createLearnedPhrase(prisma, {
    phrase: trimmed,
    category,
    note: reason,
    createdBy: operatorUserId,
    sourceReportId: reportId,
  });
  // 충돌 목록은 **등록 직후 한 번** 화면이 보여준다 (회신 5호 Q1) — 입력 중에는
  // 싣지 않는다. 되살린 항목에는 없다(그때는 잰 적이 없다)
  const { collisions = [] } = created as { collisions?: { against: string }[] };
  return { phraseWarning: null, phraseCollisions: collisions.map((c) => c.against) };
}

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json(await getAbuseReports(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const raw = (await req.json()) as Record<string, unknown>;

    if (typeof raw.reportId === 'string') {
      const body = groupSchema.parse(raw);
      // 확인인데 유형이 없으면 미탐 라벨이 비고, 빈 라벨은 검수 정확도에서 세지 못한다
      if (body.decision === 'CONFIRMED' && !body.category) {
        return NextResponse.json(
          { error: '실제 위반 유형을 골라 주세요 — 검수가 놓친 것(미탐)의 기록이 됩니다' },
          { status: 400 },
        );
      }
      const summary = await resolveAbuseReportGroup(prisma, {
        reportId: body.reportId,
        operatorUserId,
        decision: body.decision,
        note: body.note,
        categories: body.category ? [body.category] : [],
        findingsValid: body.findingsValid,
      });
      const phrase =
        body.decision === 'CONFIRMED'
          ? await registerPhrase(operatorUserId, body.reportId, body.phrase, body.category, body.note)
          : { phraseWarning: null, phraseCollisions: [] };
      // **교사 질문지 생성** (2026-08-27 창업자 지시 — 검수와 같은 흐름). 판정 커밋 뒤,
      // 최선-노력으로(실패해도 판정은 유효). 두 갈래에서 만든다:
      //   · 확인(TAKEDOWN) = 미탐. 검수가 놓친 것이라 재학습에서 가장 값진 라벨
      //   · 기각 + 지적 타당(KEPT+findingsValid) = 경계 사례. 모델이 배울 값이 있다
      // 순수 오신고(기각 + findingsValid 아님)는 verdict 를 안 써서 질문지가 안 생긴다
      if (body.decision === 'CONFIRMED' || body.findingsValid === true) {
        await storeTeacherPackForReport(prisma, body.reportId);
      }
      return NextResponse.json({ ...summary, ...phrase });
    }

    const body = singleSchema.parse(raw);
    const result = await reviewAbuseReport(prisma, { ...body, operatorUserId });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json(
        { error: e.issues[0]?.message ?? '요청 형식 오류' },
        { status: 400 },
      );
    }
    return toErrorResponse(e);
  }
}
