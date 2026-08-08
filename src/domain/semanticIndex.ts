// 의미 유사도 검색 (순수 로직).
//
// 학습 표현 사전을 **문자열 인덱스에서 의미 인덱스로 승격**시킨다.
// 지금은 "반드시 오릅니다"가 글자 그대로 있어야 걸리지만, 여기서는 같은 뜻의 다른 문장
// ("오르지 않을 이유가 없습니다")도 벡터 거리로 잡는다.
//
// 세 가지 원칙이 이 모듈의 설계를 결정한다:
//
// ① **심각도는 항상 WARN.** 임베딩은 부정에 약하다 — "원금 보장합니다"와
//    "원금 보장은 못 합니다"의 코사인 유사도가 높게 나온다. 부정을 구분하려면 분류기가
//    필요하므로(로드맵 2단계), 이 단계 결과로 게시를 거절해서는 안 된다.
// ② **문장 단위로 비교한다.** 리포트 전체를 한 벡터로 만들면 한 문장의 위반이
//    나머지 정상 문장에 희석되어 사라진다.
// ③ **모델 식별자를 함께 저장한다.** 벡터는 모델마다 좌표계가 다르므로, 모델이 바뀌면
//    기존 벡터와의 비교가 무의미해진다. 섞이면 조용히 틀린 답이 나온다.

import { RISK_CATEGORY_LABEL, type Finding, type RiskCategory } from './compliance';

export interface IndexedPhrase {
  id: string;
  phrase: string;
  category: RiskCategory;
  note: string | null;
  vector: Float32Array;
}

export interface SimilarityMatch {
  entry: IndexedPhrase;
  /** 코사인 유사도 (−1~1) */
  score: number;
  /** 걸린 원문 문장 */
  sentence: string;
}

/**
 * 유사도 임계값 (초안 — **실제 모델로 반드시 재보정해야 한다**).
 *
 * 값을 낮추면 패러프레이즈 탐지가 늘지만 오탐도 함께 는다. 이 플랫폼에서 오탐은 놓친
 * 위반보다 비싸므로(정상 리서처의 게시를 막아 공급을 잃는다) 보수적으로 시작한다.
 * 확정은 `npm run eval:screening`으로 임계값을 훑어 오탐률 기준선(19.4%)을 넘지 않는
 * 최저값을 고르는 방식으로 한다.
 */
export const SIMILARITY_THRESHOLD = 0.82;

/** 너무 짧은 문장은 의미 벡터가 불안정해 아무 데나 가까워진다 */
export const MIN_SENTENCE_LENGTH = 8;

/**
 * 한국어 문장 분리.
 * 완벽한 분리기는 아니다 — 소수점·약어에서 과분할될 수 있지만, 과분할은 검사 단위가
 * 잘게 쪼개질 뿐이라 안전한 방향의 실패다 (문장을 놓치는 것보다 낫다).
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?。？！])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_LENGTH);
}

/** 코사인 유사도. 길이가 다르면 비교 자체가 성립하지 않으므로 예외를 던진다 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`벡터 차원이 다릅니다 (${a.length} vs ${b.length}) — 모델이 섞였는지 확인하세요`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * 문장 하나에 가장 가까운 사전 항목.
 * 여러 항목이 걸려도 최고 점수 하나만 돌려준다 — 같은 문장에 대해 유형별로 소견이
 * 쏟아지면 리서처가 무엇을 고쳐야 할지 알 수 없다.
 */
export function bestMatch(
  vector: Float32Array,
  entries: IndexedPhrase[],
  threshold = SIMILARITY_THRESHOLD,
): { entry: IndexedPhrase; score: number } | null {
  let best: { entry: IndexedPhrase; score: number } | null = null;
  for (const entry of entries) {
    const score = cosineSimilarity(vector, entry.vector);
    if (score >= threshold && (!best || score > best.score)) best = { entry, score };
  }
  return best;
}

/**
 * 문장별 벡터 → 소견.
 * 같은 사전 항목이 여러 문장에 걸리면 가장 가까운 문장 하나만 남긴다 (중복 지적 방지).
 */
export function findSimilarViolations(
  sentences: string[],
  vectors: Float32Array[],
  entries: IndexedPhrase[],
  threshold = SIMILARITY_THRESHOLD,
): SimilarityMatch[] {
  const byEntry = new Map<string, SimilarityMatch>();
  sentences.forEach((sentence, i) => {
    const vector = vectors[i];
    if (!vector) return;
    const match = bestMatch(vector, entries, threshold);
    if (!match) return;
    const existing = byEntry.get(match.entry.id);
    if (!existing || match.score > existing.score) {
      byEntry.set(match.entry.id, { entry: match.entry, score: match.score, sentence });
    }
  });
  return [...byEntry.values()].sort((a, b) => b.score - a.score);
}

export function toFindings(matches: SimilarityMatch[]): Finding[] {
  return matches.map((m) => ({
    category: m.entry.category,
    // 임베딩은 부정을 구분하지 못한다 — 거절 판단에 쓸 수 없다 (§ 설계 원칙 ①)
    severity: 'WARN' as const,
    quote: m.sentence,
    reason:
      `과거 ${RISK_CATEGORY_LABEL[m.entry.category]}으로 반려된 표현과 뜻이 매우 비슷합니다` +
      `${m.entry.note ? ` (${m.entry.note})` : ''}. 표현을 바꾸거나 근거를 함께 제시해주세요.`,
    source: 'semantic' as const,
    phraseId: m.entry.id,
  }));
}
