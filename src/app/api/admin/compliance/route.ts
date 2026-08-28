import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { setLearnedPhraseActive } from '@/server/learnedPhraseService';
import { createDefaultRegistry } from '@/infra/marketData/registry';
import {
  forceWithdrawReport,
  getPendingComplianceReviews,
  markComplianceReviewed,
} from '@/server/complianceService';
import { prisma } from '@/server/db';
import { canReleaseAutoShadow, releaseAutoShadow } from '@/server/studentAutoShadow';
import { createStudentClientFromEnv } from '@/infra/compliance/studentClient';
import { approvePendingReport, rejectPendingReport } from '@/server/reportService';
import { recordDecisionElapsed } from '@/server/decisionSpeedService';
import { storeTeacherPackForReport } from '@/server/teacherPackStore';
import { ensureViolationType } from '@/server/violationTypeService';
import { requireOperatorId, toErrorResponse } from '../../_lib/http';

// 운영자 컴플라이언스 검토 큐: 2단 검수로 결론이 안 난 건에 대한 결정.
// 보류(PENDING_REVIEW) 건 — 아직 판매 전이므로 환불 문제가 없다
//  - APPROVE: 게시 승인 (기준가·수수료는 이 시점에 확정)
//  - REJECT: 반려 → 초안으로 되돌림 (사유 통지)
// 이미 게시된 건 — 승인 후 재검토·구버전 데이터
//  - RESOLVE: 게시 유지 (큐에서 제거)
//  - TAKEDOWN: 강제 철회 → 게시 중단 + 즉시 전액 환불

// 운영자 결정에는 정답 라벨이 함께 실린다 (screeningAccuracy.ts):
//  - 승인: findingsValid — **세 갈래다** (11차 K-1)
//      true  지적은 타당했다 (경미해서 통과)
//      false **오탐이라고 명시적으로 신고했다**
//      null  아무 표시 없이 승인 — 정확도 지표에는 오탐, 자동 격하에는 표본 아님
//    셋을 갈라야 하는 이유는 10차에 실측으로 드러났다: 값이 둘뿐이면 무심코 누른
//    승인이 명시적 오탐 신고와 같아지고, 25건 중 6건이면 학생 모델이 영구히 꺼진다.
//  - 반려·철회: categories — 실제 위반 유형 (비우면 검수 소견을 그대로 인정).
//    내장 key 또는 운영자가 새로 정의한 커스텀 유형 라벨(문자열). 커스텀이면 ViolationType 에 올린다
const categories = z.array(z.string().trim().min(1).max(40)).max(30).optional();
// 운영자가 본문에서 짚은 근거 문장 (회신 20호 요청 3) — IRIS 라벨 지역화용
const evidence = z.array(z.string().trim().min(1).max(1000)).max(20).optional();

// 관리자 화면이 잰 "열람 → 판정" 시간 (26차 CC-1 피로도 감지 — decisionSpeedService).
// 화면이 안 보내면 그냥 빈 칸이다 — 텔레메트리가 판정을 막으면 안 된다.
//
// **`.catch(undefined)` 가 그 문장을 실제로 지킨다.** 이게 없으면 범위 밖 값 하나가
// 판정 요청 **전체**를 400 으로 떨어뜨렸다 — 금요일에 카드를 펼쳐 놓고 월요일에
// 누르면 경과가 하루를 넘어 승인이 아예 안 됐고, 화면에는 이유가 안 나와 카드를
// 닫았다 다시 열기 전까지 계속 실패했다. 텔레메트리가 판정을 막던 자리다.
//
// **자르지 않고 버린다.** 하루를 넘는 값은 측정이 아니라 방치이므로(탭을 열어 둔 채
// 퇴근 — decisionSpeedService.MAX_ELAPSED_MS 의 근거), 상한으로 접어 넣으면 재지도
// 않은 것을 "24시간 숙고"로 적게 된다. 빈 칸으로 두면 `getApprovedElapsedCoverage`
// 가 "못 쟀다"로 세어 화면에 적는다 — 조용히 사라지지 않는다.
const decisionElapsedMs = z
  .number()
  .int()
  .positive()
  .max(86_400_000)
  .optional()
  .catch(undefined);

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('RESOLVE'), reviewId: z.string().min(1) }),
  z.object({
    action: z.literal('APPROVE'),
    reportId: z.string().min(1),
    // nullish — **`?? false` 로 접지 않는다.** 접는 순간 무응답과 신고가 같아진다
    findingsValid: z.boolean().nullish(),
    // '지적은 타당했지만 승인한' 사유 (findingsValid === true 일 때만 화면이 보낸다)
    approveReason: z.string().trim().max(500).nullish(),
    // 본문 소견 승인의 근거 문장 (2026-08-28) — 재학습 지역화 (오탐 가중치·지적타당 졸업)
    evidence,
    decisionElapsedMs,
  }),
  z.object({
    action: z.literal('REJECT'),
    reportId: z.string().min(1),
    reason: z.string().trim().min(1).max(500),
    categories,
    evidence,
    decisionElapsedMs,
  }),
  z.object({
    action: z.literal('TAKEDOWN'),
    reportId: z.string().min(1),
    reason: z.string().trim().min(1).max(500),
    categories,
    evidence,
    decisionElapsedMs,
  }),
  z.object({
    action: z.literal('SET_PHRASE_ACTIVE'),
    phraseId: z.string().min(1),
    active: z.boolean(),
  }),
  // 학생 모델 자동 격하 해제 (10차 I-6) — **거는 것은 시스템, 푸는 것은 사람**이다.
  // 자동 복구를 두지 않는 이유: 끈 동안에는 학생의 성적을 만들 재료가 없어서
  // "좋아졌다"와 "모른다"가 같은 얼굴로 나온다(studentAutoShadow.ts).
  z.object({ action: z.literal('RELEASE_STUDENT_SHADOW') }),
]);

/**
 * 위반 유형을 확정한다 (2026-08-28) — 커스텀 유형("논리적 비약")이면 ViolationType 에 올려
 * 다음부터 검수·어뷰징 선택기에 칩으로 뜨게 하고, 내장 유형이면 그대로 통과시킨다.
 * 반환값은 실제 저장될 key 목록. 검증 실패(빈 값·길이·내장 충돌)는 던진다.
 */
async function ensureCategories(
  cats: string[] | undefined,
  operatorUserId: string,
  reportId: string,
): Promise<string[]> {
  if (!cats?.length) return [];
  return Promise.all(cats.map((c) => ensureViolationType(prisma, c, operatorUserId, reportId)));
}

export async function GET() {
  try {
    await requireOperatorId(prisma);
    return NextResponse.json(await getPendingComplianceReviews(prisma));
  } catch (e) {
    return toErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const raw = (await req.json()) as Record<string, unknown>;
    // action 미지정은 기존 확인 처리로 해석 (하위 호환)
    const body = bodySchema.parse({ action: 'RESOLVE', ...raw });

    switch (body.action) {
      case 'APPROVE': {
        const published = await approvePendingReport(
          prisma,
          createDefaultRegistry(),
          body.reportId,
          operatorUserId,
          new Date(),
          body.findingsValid ?? null,
          body.approveReason ?? null,
          body.evidence ?? [],
        );
        if (body.decisionElapsedMs) {
          await recordDecisionElapsed(prisma, body.reportId, body.decisionElapsedMs);
        }
        // 판정 커밋 뒤 교사 질문지를 만들어 저장한다 (승인+표시안함이면 저장 안 함/지움)
        await storeTeacherPackForReport(prisma, body.reportId);
        return NextResponse.json({ ok: true, status: published.status });
      }
      case 'REJECT': {
        const cats = await ensureCategories(body.categories, operatorUserId, body.reportId);
        await rejectPendingReport(
          prisma,
          body.reportId,
          operatorUserId,
          body.reason,
          new Date(),
          cats,
          body.evidence ?? [],
        );
        if (body.decisionElapsedMs) {
          await recordDecisionElapsed(prisma, body.reportId, body.decisionElapsedMs);
        }
        await storeTeacherPackForReport(prisma, body.reportId);
        return NextResponse.json({ ok: true });
      }
      case 'RELEASE_STUDENT_SHADOW': {
        // **콘솔에서는 증거가 맞을 때만 풀린다** (11차 K-4). 확인 창은 문턱이 아니다 —
        // 질문에 답하는 사람과 답을 검증할 수 있는 사람이 같기 때문이다.
        // 사고 복구처럼 근거 없이 풀어야 하는 상황은 CLI 의 강제 경로로 보낸다:
        //   npx tsx scripts/unlockStudent.ts --force --reason "..."
        // 그쪽만 감사 로그에 남는다.
        const health = await createStudentClientFromEnv()?.health();
        const gate = await canReleaseAutoShadow(health?.modelSha);
        if (!gate.ok) {
          return NextResponse.json(
            {
              error: gate.reason,
              hint: '근거 없이 풀어야 한다면 `npx tsx scripts/unlockStudent.ts --force --reason "..."` 를 쓰십시오 (감사 로그에 남습니다).',
            },
            { status: 409 },
          );
        }
        await releaseAutoShadow(prisma, operatorUserId);
        return NextResponse.json({ ok: true, detail: gate.reason });
      }
      case 'SET_PHRASE_ACTIVE':
        await setLearnedPhraseActive(prisma, body.phraseId, body.active);
        return NextResponse.json({ ok: true });
      case 'TAKEDOWN': {
        const cats = await ensureCategories(body.categories, operatorUserId, body.reportId);
        const summary = await forceWithdrawReport(prisma, {
          reportId: body.reportId,
          operatorUserId,
          reason: body.reason,
          categories: cats,
          evidence: body.evidence ?? [],
        });
        if (body.decisionElapsedMs) {
          await recordDecisionElapsed(prisma, body.reportId, body.decisionElapsedMs);
        }
        await storeTeacherPackForReport(prisma, body.reportId);
        return NextResponse.json({ ok: true, ...summary });
      }
      default:
        await markComplianceReviewed(prisma, body.reviewId, operatorUserId);
        return NextResponse.json({ ok: true });
    }
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
