import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { RISK_CATEGORIES, type RegisteredPhrase, type RiskCategory } from '@/domain/compliance';
import { PHRASE_MAX_LENGTH, validatePhrase } from '@/domain/learnedPhrases';
import { createLearnedPhrase, setLearnedPhraseActive } from '@/server/learnedPhraseService';
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
import { previewPhraseRescan, recordPhraseRescan } from '@/server/phraseRescanService';
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
//  - 반려·철회: categories — 실제 위반 유형 (비우면 검수 소견을 그대로 인정)
const categories = z.array(z.enum(RISK_CATEGORIES)).max(RISK_CATEGORIES.length).optional();

// 반려·철회와 함께 등록하는 학습 표현 — 다음 리서처가 작성 단계에서 미리 경고를 받는다.
// 반려 사유를 남기는 김에 한 줄 더 적는 것이므로 운영자의 추가 작업은 거의 없다.
const phrase = z.string().trim().max(PHRASE_MAX_LENGTH * 3).optional();

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
    decisionElapsedMs,
  }),
  z.object({
    action: z.literal('REJECT'),
    reportId: z.string().min(1),
    reason: z.string().trim().min(1).max(500),
    categories,
    phrase,
    decisionElapsedMs,
  }),
  z.object({
    action: z.literal('TAKEDOWN'),
    reportId: z.string().min(1),
    reason: z.string().trim().min(1).max(500),
    categories,
    phrase,
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
 * 반려와 함께 들어온 표현을 사전에 등록한다.
 * 표현이 잘못됐다고 반려 자체를 되돌리지는 않는다 — 반려는 이미 확정된 판단이고,
 * 사전 등록은 부가 작업이다. 대신 실패 사유를 응답에 실어 운영자가 다시 시도하게 한다.
 *
 * **충돌 목록을 함께 돌려준다** (확인서 Q1 → 회신 5호). `createLearnedPhrase` 는
 * 진작부터 이것을 돌려주고 있었고 주석도 용도를 적어 두었는데
 * (*"화면이 '왜 근사 감시에서 빠졌는지'를 등록 직후 한 번 보여주면 되는 정보"*),
 * 이 함수의 반환형이 `string | null` 이라 **그 자리에서 버려지고 있었다** —
 * 서버가 만들어 보낸 정보가 화면에 한 번도 도착한 적이 없다.
 *
 * 여기가 충돌을 보여줄 **유일하게 옳은 자리**다: 입력 중(phrase-preview)에 보여주면
 * 운영자가 충돌을 피해 표현을 다듬게 되고 그건 대조 표본에 사전을 맞추는 일이지만,
 * 등록 직후에는 표현이 이미 확정돼 그 고리가 성립하지 않는다.
 */
async function registerPhrase(
  operatorUserId: string,
  reportId: string,
  text: string | undefined,
  cats: RiskCategory[] | undefined,
  reason: string,
): Promise<{ warning: string | null; collisions: string[]; rescanned?: number }> {
  const none = { warning: null, collisions: [] as string[] };
  const trimmed = text?.trim();
  if (!trimmed) return none;
  const category = cats?.[0];
  if (!category) {
    return { ...none, warning: '표현을 등록하려면 실제 위반 유형을 한 개 이상 선택해주세요' };
  }
  const issues = validatePhrase(trimmed);
  if (issues.length > 0) return { ...none, warning: issues.join(' / ') };
  const created = await createLearnedPhrase(prisma, {
    phrase: trimmed,
    category,
    note: reason,
    createdBy: operatorUserId,
    sourceReportId: reportId,
  });
  /* **등록한 표현으로 게시 중 리포트를 다시 훑는다** (2026-08-25 창업자 확정).
     학습 표현은 지금까지 **앞으로 올라올 글에만** 닿았고, 이미 팔리는 글에는 영원히
     닿지 않았다 — 위험이 큰 쪽은 오히려 그쪽이다.
     결과는 **목록일 뿐 처분이 아니다**: 게시는 그대로고 강제 철회는 사람이 따로 한다.
     실패해도 삼킨다 — 표현 등록은 이미 끝난 일이라, 곁가지가 본업을 되돌리면 안 된다. */
  const rescanned = await previewPhraseRescan(prisma, created as unknown as RegisteredPhrase)
    .then((r) => recordPhraseRescan(prisma, created.id, r.hits))
    .catch((e) => {
      console.error('새 표현 재검수 실패:', e);
      return 0;
    });

  // 이미 있던 항목을 되살린 경로에는 충돌 목록이 없다 — 그때는 잰 적이 없다
  // (`createLearnedPhrase` 의 반환이 세 갈래 합집합이라 `in` 만으로는 안 좁혀진다)
  const { collisions = [] } = created as { collisions?: { against: string }[] };
  return { warning: null, collisions: collisions.map((c) => c.against), rescanned };
}

/** 응답 모양은 한 곳에서만 만든다 — 두 갈래(반려·철회)가 다른 이름을 쓰면 화면이 갈린다 */
async function phrasePayload(
  ...args: Parameters<typeof registerPhrase>
): Promise<{ phraseWarning: string | null; phraseCollisions: string[]; phraseRescanned: number }> {
  const { warning, collisions, rescanned } = await registerPhrase(...args);
  return { phraseWarning: warning, phraseCollisions: collisions, phraseRescanned: rescanned ?? 0 };
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
        );
        if (body.decisionElapsedMs) {
          await recordDecisionElapsed(prisma, body.reportId, body.decisionElapsedMs);
        }
        // 판정 커밋 뒤 교사 질문지를 만들어 저장한다 (승인+표시안함이면 저장 안 함/지움)
        await storeTeacherPackForReport(prisma, body.reportId);
        return NextResponse.json({ ok: true, status: published.status });
      }
      case 'REJECT':
        await rejectPendingReport(
          prisma,
          body.reportId,
          operatorUserId,
          body.reason,
          new Date(),
          body.categories ?? [],
        );
        if (body.decisionElapsedMs) {
          await recordDecisionElapsed(prisma, body.reportId, body.decisionElapsedMs);
        }
        await storeTeacherPackForReport(prisma, body.reportId);
        return NextResponse.json({
          ok: true,
          ...(await phrasePayload(
            operatorUserId,
            body.reportId,
            body.phrase,
            body.categories,
            body.reason,
          )),
        });
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
        const summary = await forceWithdrawReport(prisma, {
          reportId: body.reportId,
          operatorUserId,
          reason: body.reason,
          categories: body.categories ?? [],
        });
        if (body.decisionElapsedMs) {
          await recordDecisionElapsed(prisma, body.reportId, body.decisionElapsedMs);
        }
        await storeTeacherPackForReport(prisma, body.reportId);
        return NextResponse.json({
          ok: true,
          ...summary,
          ...(await phrasePayload(
            operatorUserId,
            body.reportId,
            body.phrase,
            body.categories,
            body.reason,
          )),
        });
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
