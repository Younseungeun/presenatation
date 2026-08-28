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
 * **질문지가 저장된 건만** 줄에 세운다 (2026-08-27 창업자 지시로 기준 변경).
 * 판정 시점에 케이스별 질문지를 만들어 저장하므로(teacherPackText), 논의가 필요한
 * 케이스는 클릭 없이도 자동으로 여기 쌓인다. 논의 불필요(승인+표시 안 함)는 질문지가
 * 저장되지 않아 여기 안 뜬다 — 줄이 "물어봐야 할 것"으로만 채워진다.
 * (예전 기준: teacherAskedAt — 운영자가 복사를 눌러야 떴다. 이제는 자동 축적.)
 */
export async function getTeacherAnswerPending(
  prisma: PrismaClient,
  limit = 20,
): Promise<TeacherAnswerPending[]> {
  const rows = await prisma.complianceReview.findMany({
    where: {
      operatorVerdict: { not: null },
      teacherPackText: { not: null },
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

export interface TeacherPackDetail {
  reviewId: string;
  reportTitle: string;
  verdict: string;
  decidedAt: Date | null;
  /** 판정 시점에 저장된 케이스별 질문지 원문 (재학습 논의 자료 그 자체) */
  packText: string;
}

/**
 * 재학습 논의 자료 **상세** — 쌓인 질문지 원문을 그대로 읽는 화면용 (2026-08-28 창업자 지시).
 * 박스에서 눌러 들어와, 복사하지 않고도 논의 자료를 직접 확인한다.
 */
export async function getTeacherPackDetails(
  prisma: PrismaClient,
  limit = 50,
): Promise<TeacherPackDetail[]> {
  const rows = await prisma.complianceReview.findMany({
    where: {
      operatorVerdict: { not: null },
      teacherPackText: { not: null },
      teacherAnswer: { is: null },
    },
    orderBy: { operatorReviewedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      operatorVerdict: true,
      operatorReviewedAt: true,
      teacherPackText: true,
      report: { select: { title: true } },
    },
  });
  return rows.map((r) => ({
    reviewId: r.id,
    reportTitle: r.report.title,
    verdict: r.operatorVerdict ?? '',
    decidedAt: r.operatorReviewedAt,
    packText: r.teacherPackText ?? '',
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
 * 최근 N일의 교사 질의 실태 (2026-08-27 자동 저장 흐름에 맞춰 재정의).
 *
 * 질문지가 판정 시점에 **자동 생성·저장**되므로 "안 물어보고 내렸다"는 고장은 사라졌다
 * (논의가 필요한 케이스는 전부 저장된다). 남는 것은 **답 대기**와 **교사 갈림**이다:
 *   decided   질문지가 저장된 건 = 논의가 필요했던 건 (teacherPackText 있음)
 *   answered  그중 답까지 기록된 건
 *   decided − answered  답을 아직 안 걷은 건 (일괄 처리 대기 backlog)
 *   disagreed 교사가 사람과 갈린 비율 (교사 품질 · 교정 사례의 원천)
 *
 * `asked`(복사 눌러 뽑은 건)는 이제 자동이라 decided 와 같게 둔다 — 인터페이스 호환용.
 */
export async function getTeacherAskCoverage(
  prisma: PrismaClient,
  days = 30,
  now = new Date(),
): Promise<TeacherAskCoverage> {
  const since = new Date(now.getTime() - days * 86_400_000);
  // 질문지가 저장된 건만 분모다 — 논의 불필요(승인+표시 안 함)는 애초에 물어볼 대상이 아니다
  const base = {
    operatorReviewedAt: { gte: since },
    teacherPackText: { not: null },
  } as const;

  const [decided, answered, disagreed] = await Promise.all([
    prisma.complianceReview.count({ where: base }),
    prisma.complianceReview.count({ where: { ...base, teacherAnswer: { isNot: null } } }),
    prisma.complianceReview.count({
      where: { ...base, teacherAnswer: { is: { disagreed: true } } },
    }),
  ]);
  // asked = decided: 자동 저장이라 "물어봤다"가 곧 "판정했다"
  return { decided, asked: decided, answered, disagreed };
}
