import type { PrismaClient } from '@prisma/client';
import type { RiskCategory, ScreeningInput } from '@/domain/compliance';
import type { Finding } from '@/domain/compliance';
import {
  findSimilarViolations,
  splitSentences,
  toFindings,
  type IndexedPhrase,
} from '@/domain/semanticIndex';
import { normalizePhrase } from '@/domain/learnedPhrases';
import type { EmbeddingProvider } from '@/infra/embedding/provider';

// 의미 인덱스의 저장·조회·검색.
//
// 학습 표현 사전은 이미 있다(운영자가 반려하며 등록한 문장들). 여기서는 그 사전을
// 벡터로 한 번 변환해 두고, 리포트 문장과의 거리로 "다르게 쓴 같은 뜻"을 찾는다.
//
// 벡터는 등록 시점에 계산해 저장한다 — 검수마다 사전 전체를 다시 임베딩하면
// 비용이 사전 크기에 비례해 늘어나기 때문.

/**
 * 현재 모델로 만든 벡터만 인덱스에 올린다.
 *
 * 모델이 바뀌면 벡터의 좌표계가 달라 코사인 거리가 아무 의미가 없어진다.
 * 차원이 우연히 같으면 예외도 안 나고 **조용히 틀린 답**이 나오므로,
 * 모델 식별자가 다른 벡터는 아예 제외하고 재계산 대상으로 남긴다.
 */
export async function loadSemanticIndex(
  prisma: PrismaClient,
  provider: EmbeddingProvider,
): Promise<IndexedPhrase[]> {
  const rows = await prisma.learnedPhrase.findMany({
    where: { active: true, vectorModel: provider.id, vectorJson: { not: null } },
    select: { id: true, phrase: true, category: true, note: true, vectorJson: true },
  });

  return rows.flatMap((r): IndexedPhrase[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.vectorJson!);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed) || parsed.length !== provider.dimensions) return [];
    return [
      {
        id: r.id,
        phrase: r.phrase,
        category: r.category as RiskCategory,
        note: r.note,
        vector: Float32Array.from(parsed as number[]),
      },
    ];
  });
}

/**
 * 벡터가 없거나 모델이 바뀐 표현을 다시 계산한다 (등록 직후·모델 교체 후 실행).
 * 반환값은 갱신 건수 — 배치 스크립트가 결과를 보고할 수 있게.
 */
export async function backfillPhraseVectors(
  prisma: PrismaClient,
  provider: EmbeddingProvider,
  batchSize = 32,
): Promise<number> {
  const stale = await prisma.learnedPhrase.findMany({
    where: { active: true, OR: [{ vectorJson: null }, { vectorModel: { not: provider.id } }] },
    select: { id: true, phrase: true },
  });
  if (stale.length === 0) return 0;

  let updated = 0;
  for (let i = 0; i < stale.length; i += batchSize) {
    const chunk = stale.slice(i, i + batchSize);
    const vectors = await provider.embed(chunk.map((p) => p.phrase));
    await prisma.$transaction(
      chunk.map((p, j) =>
        prisma.learnedPhrase.update({
          where: { id: p.id },
          data: {
            vectorJson: JSON.stringify([...vectors[j]]),
            vectorModel: provider.id,
          },
        }),
      ),
    );
    updated += chunk.length;
  }
  return updated;
}

/**
 * 리포트 본문에서 의미가 비슷한 위반 표현을 찾는다.
 *
 * 이미 글자 일치(matchLearnedPhrases)로 잡힌 표현은 제외한다 — 같은 사전 항목으로
 * 소견이 두 번 나오면 리서처는 두 군데를 고쳐야 하는 줄 안다.
 */
export async function findSemanticFindings(
  input: ScreeningInput,
  entries: IndexedPhrase[],
  provider: EmbeddingProvider,
  alreadyMatchedPhraseIds: string[] = [],
): Promise<Finding[]> {
  if (entries.length === 0) return [];
  const matched = new Set(alreadyMatchedPhraseIds);
  const candidates = entries.filter((e) => !matched.has(e.id));
  if (candidates.length === 0) return [];

  const sentences = splitSentences(`${input.title}\n${input.summary}\n${input.content}`);
  if (sentences.length === 0) return [];

  const vectors = await provider.embed(sentences);
  return toFindings(findSimilarViolations(sentences, vectors, candidates));
}

/** 등록된 표현과 사실상 같은 문장인지 (중복 등록 방지에 재사용) */
export function isSamePhrase(a: string, b: string): boolean {
  return normalizePhrase(a) === normalizePhrase(b);
}
