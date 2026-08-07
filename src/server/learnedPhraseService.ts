import type { PrismaClient } from '@prisma/client';
import type { RiskCategory } from '@/domain/compliance';
import {
  needsReview,
  normalizePhrase,
  phrasePrecision,
  validatePhrase,
  type LearnedPhrase,
  type PhraseStat,
} from '@/domain/learnedPhrases';

// 학습 표현 사전의 저장·조회.
// 등록은 운영자가 반려·철회를 내리는 순간에만 일어난다 — 근거 없는 금지어가 쌓이지 않게
// "실제로 반려한 건"에 붙여서만 만든다.

export class LearnedPhraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LearnedPhraseError';
  }
}

type PhraseRow = {
  id: string;
  phrase: string;
  normalized: string;
  category: string;
  note: string | null;
};

const toDomain = (r: PhraseRow): LearnedPhrase => ({
  id: r.id,
  phrase: r.phrase,
  normalized: r.normalized,
  category: r.category as RiskCategory,
  note: r.note,
});

/** 검수·작성 화면이 함께 쓰는 활성 표현 목록 */
export async function getActiveLearnedPhrases(prisma: PrismaClient): Promise<LearnedPhrase[]> {
  const rows = await prisma.learnedPhrase.findMany({
    where: { active: true },
    select: { id: true, phrase: true, normalized: true, category: true, note: true },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toDomain);
}

export interface CreatePhraseInput {
  phrase: string;
  category: RiskCategory;
  note?: string | null;
  createdBy: string;
  sourceReportId?: string | null;
}

export async function createLearnedPhrase(prisma: PrismaClient, input: CreatePhraseInput) {
  const phrase = input.phrase.trim();
  const issues = validatePhrase(phrase);
  if (issues.length > 0) throw new LearnedPhraseError(issues.join(' / '));

  const normalized = normalizePhrase(phrase);
  // 같은 표현을 두 번 등록하면 리서처에게 같은 경고가 두 번 뜬다
  const existing = await prisma.learnedPhrase.findFirst({
    where: { normalized, category: input.category },
  });
  if (existing) {
    // 비활성 상태였다면 되살린다 (같은 위반이 다시 확인된 것이므로)
    if (!existing.active) {
      return prisma.learnedPhrase.update({ where: { id: existing.id }, data: { active: true } });
    }
    return existing;
  }

  return prisma.learnedPhrase.create({
    data: {
      phrase,
      normalized,
      category: input.category,
      note: input.note?.trim() || null,
      createdBy: input.createdBy,
      sourceReportId: input.sourceReportId ?? null,
    },
  });
}

export async function setLearnedPhraseActive(
  prisma: PrismaClient,
  id: string,
  active: boolean,
) {
  await prisma.learnedPhrase.update({ where: { id }, data: { active } });
}

/** 운영자 관리 화면용 — 정확도가 낮은 표현이 위로 오게 정렬한다 */
export async function getLearnedPhraseStats(prisma: PrismaClient) {
  const rows = await prisma.learnedPhrase.findMany({
    orderBy: { createdAt: 'desc' },
  });
  const stats = rows.map((r) => {
    const stat: PhraseStat = {
      id: r.id,
      phrase: r.phrase,
      category: r.category as RiskCategory,
      matchCount: r.matchCount,
      confirmedCount: r.confirmedCount,
      active: r.active,
    };
    return {
      ...stat,
      note: r.note,
      createdAt: r.createdAt,
      lastMatchedAt: r.lastMatchedAt,
      precision: phrasePrecision(stat),
      needsReview: needsReview(stat),
    };
  });
  // 재검토 대상 → 활성 → 최신 순
  return stats.sort(
    (a, b) => Number(b.needsReview) - Number(a.needsReview) || Number(b.active) - Number(a.active),
  );
}
