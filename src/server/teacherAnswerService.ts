import type { PrismaClient } from '@prisma/client';
import {
  parseTeacherAnswer,
  teacherPackId,
  TEACHER_ANSWER_PROBLEM_MESSAGE,
  type TeacherAnswer,
} from '@/domain/teacherAnswer';
import type { CalibrationExample } from '@/domain/screeningAccuracy';
import type { RiskCategory } from '@/domain/compliance';

// **교사 답을 기록한다 — 운영자가 먼저 판단한 뒤에만** (18차 V-3).
//
// ── 순서가 이 표의 값어치 전부다 ─────────────────────────────────────
// 자동 2차에서는 교사와 운영자가 독립이었다. 사람이 나르면 운영자가 교사 답을 **보고**
// 고르게 되고, 그 순간 두 값이 같은 출처가 된다 — 정확도 지표가 자기 자신을 재게 된다.
//
// 검토의 결론: *"독립성은 코드 구조가 아니라 작업자의 클릭 순서에서 나온다."*
// 그래서 이 함수는 **운영자 판정이 없으면 거절한다.** 화면이 순서를 안내하는 것으로는
// 부족하다 — 안내는 지켜지지 않고, 지켜지지 않은 것은 기록에 남지 않는다.
//
// ── 불일치가 곧 교사 품질 지표다 ─────────────────────────────────────
// 운영자가 먼저 고른 결론과 교사 답이 갈렸는가(`disagreed`)를 저장한다. 이 값이
//   ① 교사를 얼마나 믿을 수 있나 (불일치율)
//   ② 다음 질문지에 실을 교정 사례 (18차 V-5 — 틀린 것을 사람이 고친 기록만)
// 둘 다의 원천이다.

export class TeacherAnswerError extends Error {}

export interface RecordTeacherAnswerInput {
  reviewId: string;
  /** 운영자가 대화창에서 복사해 온 답 원문 */
  text: string;
  /** 지금 쓰는 교사 표식 (18차 V-4) */
  teacherTag: string;
  operatorUserId: string;
}

export interface RecordedTeacherAnswer {
  answer: TeacherAnswer;
  /** 운영자가 먼저 고른 결론과 갈렸는가 */
  disagreed: boolean;
}

/**
 * 교사 답을 기록한다.
 *
 * @throws TeacherAnswerError 운영자 판정이 아직 없거나, 답을 못 읽었을 때.
 *   **지어내지 않는다** — 못 읽은 답을 억지로 해석하면 틀린 라벨이 학습 자료가 된다.
 */
export async function recordTeacherAnswer(
  prisma: PrismaClient,
  input: RecordTeacherAnswerInput,
): Promise<RecordedTeacherAnswer> {
  const review = await prisma.complianceReview.findUnique({
    where: { id: input.reviewId },
    select: {
      id: true,
      operatorVerdict: true,
      operatorCategories: true,
      aiFindingsValid: true,
    },
  });
  if (!review) throw new TeacherAnswerError('검수 기록을 찾을 수 없습니다');

  // ── 순서 강제 ──
  if (!review.operatorVerdict) {
    throw new TeacherAnswerError(
      '먼저 승인·반려를 결정해 주세요. 교사 답은 그 뒤에 기록됩니다 — ' +
        '답을 보고 고르면 두 판단이 같은 출처가 되어, 교사가 정확한 것인지 ' +
        '확인을 건너뛴 것인지 영원히 가릴 수 없게 됩니다.',
    );
  }

  const { answer, problem } = parseTeacherAnswer(input.text, teacherPackId(review.id));
  if (!answer) {
    throw new TeacherAnswerError(TEACHER_ANSWER_PROBLEM_MESSAGE[problem!]);
  }

  const disagreed = disagrees(answer, {
    verdict: review.operatorVerdict,
    categories: parseCategories(review.operatorCategories),
    findingsValid: review.aiFindingsValid,
  });

  await prisma.teacherAnswer.upsert({
    where: { complianceReviewId: review.id },
    create: {
      complianceReviewId: review.id,
      teacherTag: input.teacherTag,
      labelsJson: JSON.stringify(answer.labels),
      findingsValid: answer.findingsValid,
      rawAnswer: input.text.slice(0, 20_000),
      disagreed,
      recordedBy: input.operatorUserId,
    },
    // 한 건을 두 번 물어볼 수 있다(답이 애매했을 때). 마지막 답이 남는다
    update: {
      teacherTag: input.teacherTag,
      labelsJson: JSON.stringify(answer.labels),
      findingsValid: answer.findingsValid,
      rawAnswer: input.text.slice(0, 20_000),
      disagreed,
      recordedBy: input.operatorUserId,
    },
  });

  return { answer, disagreed };
}

interface OperatorDecision {
  verdict: string;
  categories: RiskCategory[];
  findingsValid: boolean | null;
}

/**
 * 운영자 결론과 교사 답이 갈렸는가.
 *
 * **결론 수준에서 본다** — 유형 목록이 완전히 같은지가 아니라 "위반인가 아닌가"와
 * "오탐이었나"가 갈리는지를 본다. 유형 하나 차이로 불일치를 세면 대부분이 불일치가 되어
 * 지표가 죽고, 교정 사례가 잡음으로 찬다.
 */
export function disagrees(answer: TeacherAnswer, op: OperatorDecision): boolean {
  const operatorSaysViolation = op.verdict === 'REJECTED' || op.verdict === 'TAKEDOWN';
  const teacherSaysViolation = answer.labels.length > 0;
  if (operatorSaysViolation !== teacherSaysViolation) return true;

  // 둘 다 위반이라고 했으면 **유형이 하나도 안 겹칠 때만** 갈린 것으로 본다.
  // 겹치는 유형이 있으면 같은 것을 보고 있다 — 이름을 몇 개 더 붙였는지는 결론이 아니다
  if (operatorSaysViolation) {
    if (op.categories.length === 0) return false; // "검수 소견 그대로 인정" — 대조할 것이 없다
    return !answer.labels.some((l) => op.categories.includes(l));
  }

  // 둘 다 위반 없음이면 **오탐이냐 경미냐**가 갈리는지 본다.
  // 운영자가 아무 표시 없이 승인했으면(null) 대조할 값이 없다
  if (op.findingsValid == null || answer.findingsValid == null) return false;
  return op.findingsValid !== answer.findingsValid;
}

function parseCategories(json: string | null): RiskCategory[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as RiskCategory[]) : [];
  } catch {
    return [];
  }
}

/**
 * 다음 질문지에 실을 교정 사례 — **교사가 틀렸고 사람이 고친 기록만** (18차 V-5).
 *
 * 자동 경로의 `getCalibrationExamples` 를 쓰지 않는다. 그쪽은 `f.source === 'rule'` 인
 * 소견을 걸러 내는데, **수동 경로에는 규칙 소견밖에 없어서** 결과가 영원히 0건이 된다.
 * (측정한 값이 운영에서 0이 되는 고장은 이 저장소에서 이미 한 번 났다 — 배선 누락.)
 *
 * 대신 불일치 건에서 뽑는다. 교사가 맞힌 것을 다시 먹이는 것은 의미가 없고,
 * 틀린 것을 사람이 교정한 기록만이 교사를 개선한다.
 *
 * @param limit 기본 4 — 사람이 복사하는 문서라 길이가 곧 부담이다 (자동 경로는 8).
 */
export async function getTeacherCorrections(
  prisma: PrismaClient,
  limit = 4,
): Promise<CalibrationExample[]> {
  const rows = await prisma.teacherAnswer.findMany({
    where: { disagreed: true },
    orderBy: { createdAt: 'desc' },
    take: limit * 3, // 인용문이 없는 건이 걸러지므로 넉넉히
    select: {
      labelsJson: true,
      findingsValid: true,
      complianceReview: {
        select: {
          operatorVerdict: true,
          operatorReason: true,
          operatorCategories: true,
          findingsJson: true,
        },
      },
    },
  });

  const out: CalibrationExample[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const review = row.complianceReview;
    const teacherLabels = parseCategories(row.labelsJson);
    const opCategories = parseCategories(review.operatorCategories);
    const opSaysViolation =
      review.operatorVerdict === 'REJECTED' || review.operatorVerdict === 'TAKEDOWN';

    // 인용문은 1차 소견에서 가져온다 — 교사 답에는 인용이 없다
    const quote = firstQuote(review.findingsJson);
    if (!quote) continue;

    // 교사가 **없다고 한 것을 사람이 위반으로 확정**했으면 미탐 교정,
    // 교사가 **있다고 한 것을 사람이 정상으로 판단**했으면 오탐 교정
    const kind = opSaysViolation ? 'miss' : 'falsePositive';
    const category = (opSaysViolation ? opCategories[0] : teacherLabels[0]) ?? null;
    if (!category) continue;

    const key = `${kind}:${category}:${quote}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      kind,
      category,
      quote,
      note:
        review.operatorReason?.trim() ||
        (opSaysViolation
          ? '교사는 정상으로 봤으나 운영자가 위반으로 확정함'
          : '교사는 위반으로 봤으나 운영자가 정상으로 판정함'),
    });
    if (out.length >= limit) break;
  }
  return out;
}

function firstQuote(findingsJson: string): string | null {
  try {
    const v = JSON.parse(findingsJson) as { quote?: string }[];
    if (!Array.isArray(v)) return null;
    for (const f of v) {
      const q = f.quote?.trim().slice(0, 120);
      if (q) return q;
    }
  } catch {
    /* 못 읽으면 사례로 안 쓴다 */
  }
  return null;
}
