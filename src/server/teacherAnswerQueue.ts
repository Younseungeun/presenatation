import type { PrismaClient } from '@prisma/client';

// **답을 기다리는 줄과, 안 물어보고 내린 결정의 비율** (18차 V-3 · V-7).
//
// ── 왜 큐가 따로 필요한가 ────────────────────────────────────────────
// 18차 V-3이 순서를 뒤집었다: 운영자가 **먼저** 결정하고 교사 답은 그 뒤에 기록한다.
// 그런데 결정한 건은 보류 큐에서 사라진다 — 답을 적을 자리가 없어진다.
// 그래서 "결정은 났는데 교사 답이 아직 없는 건"이 자기 줄을 갖는다.
//
// ── 이 줄이 재는 것 ──────────────────────────────────────────────────
// 검토가 지목한 가장 나쁜 결말: *"큐가 밀리면 운영자가 안 물어보고 그냥 승인한다.
// 라벨은 남는데 근거가 없고, 그 라벨이 학습셋에 섞인다."* 그리고 **조용히** 일어난다 —
// 결과만 보면 정상 운영과 구별되지 않는다.
//
// `teacherAskedAt` 이 그 침묵을 소리로 바꾼다. 질문지를 뽑지 않고 내려진 결정의 비율이
// 곧 확인을 건너뛴 비율이다.

export interface TeacherAnswerPending {
  reviewId: string;
  reportId: string;
  reportTitle: string;
  verdict: string;
  askedAt: Date | null;
  decidedAt: Date | null;
}

/**
 * 운영자 결정은 났는데 교사 답이 아직 없는 건.
 *
 * **질문지를 뽑은 건만** 줄에 세운다. 안 뽑은 건은 애초에 물어볼 생각이 없었던 것이라
 * 여기 세우면 줄이 영원히 안 줄고, 줄어들지 않는 큐는 곧 아무도 안 보는 큐가 된다.
 * 그쪽은 큐가 아니라 **비율**로 잡는다 (`getTeacherAskCoverage`).
 */
export async function getTeacherAnswerPending(
  prisma: PrismaClient,
  limit = 20,
): Promise<TeacherAnswerPending[]> {
  const rows = await prisma.complianceReview.findMany({
    where: {
      operatorVerdict: { not: null },
      teacherAskedAt: { not: null },
      teacherAnswer: { is: null },
    },
    orderBy: { operatorReviewedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      reportId: true,
      operatorVerdict: true,
      operatorReviewedAt: true,
      teacherAskedAt: true,
      report: { select: { title: true } },
    },
  });
  return rows.map((r) => ({
    reviewId: r.id,
    reportId: r.reportId,
    reportTitle: r.report.title,
    verdict: r.operatorVerdict ?? '',
    askedAt: r.teacherAskedAt,
    decidedAt: r.operatorReviewedAt,
  }));
}

export interface TeacherAskCoverage {
  /** 소견이 있어 사람 판단이 필요했던 결정 수 */
  decided: number;
  /** 그중 질문지를 뽑은 건 */
  asked: number;
  /** 그중 답까지 기록된 건 */
  answered: number;
  /** 교사 답과 운영자 결정이 갈린 비율 — 교사를 얼마나 믿을 수 있나 (18차 V-3) */
  disagreed: number;
}

/**
 * 최근 N일의 교사 질의 실태.
 *
 * **세 숫자가 서로 다른 고장을 가리킨다:**
 *   decided − asked   안 물어보고 내렸다 (큐가 밀렸거나 확인을 건너뛰었다)
 *   asked − answered  물어봤는데 답을 안 적었다 (라벨이 새고 있다)
 *   disagreed         교사가 사람과 갈린 비율 (교사 품질 · 교정 사례의 원천)
 *
 * 한 숫자로 접으면 어느 쪽이 아픈지 알 수 없다.
 */
export async function getTeacherAskCoverage(
  prisma: PrismaClient,
  days = 30,
  now = new Date(),
): Promise<TeacherAskCoverage> {
  const since = new Date(now.getTime() - days * 86_400_000);
  // 소견 없이 통과한 건은 애초에 물어볼 대상이 아니다 — 분모에 넣으면 비율이
  // 트래픽에 희석돼 고장이 안 보인다
  const base = {
    operatorVerdict: { not: null },
    operatorReviewedAt: { gte: since },
    needsOperatorReview: true,
  } as const;

  const [decided, asked, answered, disagreed] = await Promise.all([
    prisma.complianceReview.count({ where: base }),
    prisma.complianceReview.count({ where: { ...base, teacherAskedAt: { not: null } } }),
    prisma.complianceReview.count({ where: { ...base, teacherAnswer: { isNot: null } } }),
    prisma.complianceReview.count({
      where: { ...base, teacherAnswer: { is: { disagreed: true } } },
    }),
  ]);
  return { decided, asked, answered, disagreed };
}
