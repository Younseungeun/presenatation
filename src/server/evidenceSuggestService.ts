import type { PrismaClient } from '@prisma/client';
import type { Finding } from '@/domain/compliance';
import { rankEvidenceSentences, type EvidenceSuggestion } from '@/domain/evidenceSuggest';
import { getActiveLearnedPhrases } from './learnedPhraseService';

// 근거 문장 추천의 **수집** (12차 C-3). 순위는 domain/evidenceSuggest(순수).
// 사전은 여기(서버)에서만 맞추고, 화면에는 본문 문장만 돌아간다 — 사전이 밖으로 새지 않는다.

export class EvidenceSuggestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvidenceSuggestError';
  }
}

export async function suggestEvidence(
  prisma: PrismaClient,
  input: { reportId: string; categories?: string[] },
): Promise<EvidenceSuggestion[]> {
  const report = await prisma.report.findUnique({
    where: { id: input.reportId },
    select: { title: true, summary: true, content: true },
  });
  if (!report) throw new EvidenceSuggestError('리포트를 찾을 수 없습니다');

  // 최신 검수 기록의 소견 인용문 — 규칙·사전이 이미 짚은 자리 (학생 소견은 인용문이 없다)
  const latest = await prisma.complianceReview.findFirst({
    where: { reportId: input.reportId },
    orderBy: { createdAt: 'desc' },
    select: { findingsJson: true },
  });
  let quotes: string[] = [];
  if (latest) {
    try {
      quotes = (JSON.parse(latest.findingsJson) as Finding[]).map((f) => f.quote).filter((q) => !!q);
    } catch {
      quotes = [];
    }
  }

  const phrases = (await getActiveLearnedPhrases(prisma)).map((p) => ({
    normalized: p.normalized,
    category: p.category,
  }));

  return rankEvidenceSentences({
    content: [report.title, report.summary, report.content].filter(Boolean).join('\n'),
    phrases,
    quotes,
    categories: input.categories,
  });
}
