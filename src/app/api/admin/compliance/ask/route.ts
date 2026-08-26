import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { getTeacherTag, setTeacherTag } from '@/server/appSettings';
import { buildTeacherPack } from '@/server/teacherPack';
import {
  getTeacherCorrections,
  recordTeacherAnswer,
  TeacherAnswerError,
} from '@/server/teacherAnswerService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

/**
 * 수동 2차 검수의 두 방향 (2026-08-21 사용자 확정 · 18차 검토 반영).
 *
 *   GET  질문지를 만들어 준다 — 운영자가 복사해 교사에게 붙여 넣는다
 *   POST 받은 답을 기록한다 — **운영자 판정이 먼저 있어야 한다**
 *
 * **왜 화면에 미리 싣지 않고 눌렀을 때 받아 오는가**: 질문지에는 운영 규정문 전체가
 * 들어가 건당 3KB 남짓이다. 보류 카드마다 렌더 결과에 실으면 목록 한 번에 수십 KB가
 * 되는데, 실제로 누르는 카드는 한 번에 하나다.
 *
 * 규정문이 나가는 곳이 운영자 화면뿐인 것도 중요하다 — 리서처에게는 금지 목록을
 * 보여주지 않는다(규칙을 이진 탐색하게 된다). 이 라우트가 운영자 관문 뒤에 있는 이유다.
 */
export async function GET(req: NextRequest) {
  try {
    await requireOperatorId(prisma);

    // **일괄 복사** (2026-08-27 창업자 지시) — 답을 아직 안 걷은 질문지를 모두 이어 붙여
    // 한 번에 가져간다. 각 질문지는 맨 위 맥락 폐기 문구로 서로 격리되므로 붙여도 섞이지
    // 않는다. 사이에 구분선을 둬 어디서 끊어 새 대화창에 넣을지 눈에 보이게 한다
    if (req.nextUrl.searchParams.get('all') === '1') {
      const rows = await prisma.complianceReview.findMany({
        where: { teacherPackText: { not: null }, teacherAnswer: { is: null } },
        orderBy: { operatorReviewedAt: 'desc' },
        take: 50,
        select: { teacherPackText: true, report: { select: { title: true } } },
      });
      if (rows.length === 0) {
        return NextResponse.json({ error: '답을 기다리는 질문지가 없습니다' }, { status: 404 });
      }
      const sep = '\n\n' + '═'.repeat(60) + '\n※ 여기서부터 새 대화창에 넣어 주세요 (앞 건과 섞이지 않게)\n' + '═'.repeat(60) + '\n\n';
      const text = rows.map((r) => r.teacherPackText).join(sep);
      return NextResponse.json({ text, count: rows.length });
    }

    const reviewId = req.nextUrl.searchParams.get('reviewId');
    if (!reviewId) {
      return NextResponse.json({ error: '검수 기록을 지정해 주세요' }, { status: 400 });
    }

    const teacher = await getTeacherTag(prisma);
    // **저장된 질문지가 있으면 그것을 그대로 준다** (2026-08-27 창업자 지시) — 판정 시점에
    // 만들어 박아 둔 스냅샷이라, 그때 실제로 보낸 것과 한 글자도 다르지 않다. 없을 때만
    // 새로 만든다(옛 판정·저장 실패 대비). 무작위 경계가 매번 다른 문제를 스냅샷이 없앤다
    const stored = await prisma.complianceReview.findUnique({
      where: { id: reviewId },
      select: { teacherPackText: true },
    });
    if (stored?.teacherPackText) {
      await prisma.complianceReview
        .update({ where: { id: reviewId }, data: { teacherAskedAt: new Date() } })
        .catch((e) => console.error('교사 질의 시각 기록 실패:', e));
      return NextResponse.json({
        text: stored.teacherPackText,
        teacherTag: teacher.tag,
        teacherTagStale: teacher.stale,
      });
    }
    // 표식이 낡았어도 **질문지는 만들어 준다.** 막으면 운영자가 확인 창을 닫으려고
    // 아무 값이나 넣는다 — 잡으려던 것(조용한 오염)을 오히려 만든다.
    // 기록 시점(POST)에 막는 것으로 충분하다: 라벨이 남는 자리는 거기다
    const corrections = await getTeacherCorrections(prisma).catch(() => []);
    const pack = await buildTeacherPack(prisma, reviewId, {
      teacherTag: teacher.tag ?? '(미지정)',
      corrections,
    });
    if (!pack) {
      return NextResponse.json({ error: '검수 기록을 찾을 수 없습니다' }, { status: 404 });
    }

    // **뽑았다는 사실을 남긴다** (18차 V-7). 이 값이 없는 판정 = 안 물어보고 내린 결정이고,
    // 그 비율이 "큐가 밀려 운영자가 확인을 건너뛰는" 조용한 고장의 유일한 계기판이다.
    // 실패해도 질문지는 나간다 — 계측이 운영을 멈추면 안 된다
    await prisma.complianceReview
      .update({ where: { id: reviewId }, data: { teacherAskedAt: new Date() } })
      .catch((e) => console.error('교사 질의 시각 기록 실패:', e));

    return NextResponse.json({
      ...pack,
      teacherTag: teacher.tag,
      teacherTagStale: teacher.stale,
      corrections: corrections.length,
    });
  } catch (e) {
    return toErrorResponse(e);
  }
}

const answerSchema = z.object({
  reviewId: z.string().min(1),
  /** 대화창에서 복사해 온 답 원문 */
  text: z.string().trim().min(1).max(20_000),
  /**
   * 이번에 쓴 교사 표식. **화면이 확인시킨 값을 함께 보낸다** — 서버가 설정만 읽으면
   * 운영자가 확인 창을 지나쳤는지 알 수 없다 (18차 V-4)
   */
  teacherTag: z.string().trim().min(1).max(120),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = answerSchema.parse(await req.json());

    // 확인한 표식을 그대로 설정에 다시 찍는다 — 이것이 "오늘 확인했다"의 기록이다
    await setTeacherTag(prisma, body.teacherTag, operatorUserId);

    const result = await recordTeacherAnswer(prisma, {
      reviewId: body.reviewId,
      text: body.text,
      teacherTag: body.teacherTag,
      operatorUserId,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof TeacherAnswerError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '요청 형식 오류', issues: e.issues }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
