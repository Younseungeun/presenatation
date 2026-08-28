import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getAbuseReports, reviewAbuseReport } from '@/server/abuseReportService';
import { resolveAbuseReportGroup } from '@/server/abuseResolveService';
import { prisma } from '@/server/db';
import { storeTeacherPackForReport } from '@/server/teacherPackStore';
import { ensureViolationType } from '@/server/violationTypeService';
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
  // 내장 유형 key 또는 운영자가 새로 정의한 유형 라벨 — 둘 다 문자열이다 (2026-08-28).
  // 커스텀이면 ViolationType 에 보장해 다음부터 칩으로 뜨게 한다
  category: z.string().min(1).max(40).optional(),
  // 근거 문장 지목 — 강제 철회(미탐)·지적 타당(경계)의 재학습 자료 근거 (필수는 UI 가 강제)
  evidence: z.array(z.string().min(1)).max(20).optional(),
  // 기각일 때만 의미 — "지적은 타당했다(경미)". 무고에서 빼고 경계 사례로 학습에 남긴다
  findingsValid: z.boolean().optional(),
});

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
      // **커스텀 유형이면 보장한다** (2026-08-28) — 새로 정의한 유형("논리적 비약")을
      // ViolationType 에 올려 다음부터 칩으로 뜨게 한다. 반환값이 실제 저장될 key.
      // 내장 유형이면 그대로 통과한다. 검증 실패(빈 값·길이·내장 충돌)는 여기서 던진다
      const category = body.category
        ? await ensureViolationType(prisma, body.category, operatorUserId, body.reportId)
        : undefined;
      const summary = await resolveAbuseReportGroup(prisma, {
        reportId: body.reportId,
        operatorUserId,
        decision: body.decision,
        note: body.note,
        categories: category ? [category] : [],
        // 근거 문장 지목 — 강제 철회·지적 타당의 재학습 자료 근거 (회신 20호 요청 3)
        evidence: body.evidence,
        findingsValid: body.findingsValid,
      });
      // **교사 질문지 생성** (2026-08-27 창업자 지시 — 검수와 같은 흐름). 판정 커밋 뒤,
      // 최선-노력으로(실패해도 판정은 유효). 두 갈래에서 만든다:
      //   · 확인(TAKEDOWN) = 미탐. 검수가 놓친 것이라 재학습에서 가장 값진 라벨
      //   · 기각 + 지적 타당(KEPT+findingsValid) = 경계 사례. 모델이 배울 값이 있다
      // 순수 오신고(기각 + findingsValid 아님)는 verdict 를 안 써서 질문지가 안 생긴다
      if (body.decision === 'CONFIRMED' || body.findingsValid === true) {
        await storeTeacherPackForReport(prisma, body.reportId);
      }
      return NextResponse.json(summary);
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
