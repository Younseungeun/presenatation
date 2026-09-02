import type { PrismaClient } from '@prisma/client';
import {
  runFormalizationProbe,
  type FormalizationProbeResult,
  type ProbeSentence,
} from '@/domain/formalizationProbe';
import { controlSentences } from './learnedPhraseService';

// 공식화 샌드박스의 **수집·저장** (12차 검토 C-4, 2026-09-01). 실행은 domain/formalizationProbe(순수).
//
// 재료 둘:
//   · 이 표현이 잡은 문장 스냅샷(LearnedPhraseHit) — 사람 판정으로 정탐(반려·철회) / 정상(승인)
//   · 대조군 54문장(training/holdout/control-hand.jsonl) — 정상 산문. 채점지(손코퍼스)는 쓰지 않는다
//     (21차 Y-4: 채점지와 충돌 안 나게 맞추면 내부 시험 오탐률이 인위적으로 0에 붙는다)
// 결과는 표현에 **마지막 한 번만** 저장한다 — 졸업 관문이 보는 것은 "가장 최근 시도가 실패했나"다.

export class FormalizationProbeServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormalizationProbeServiceError';
  }
}

export async function probeFormalization(
  prisma: PrismaClient,
  input: { phraseId: string; pattern: string; isRegex: boolean },
  now = new Date(),
): Promise<FormalizationProbeResult> {
  const phrase = await prisma.learnedPhrase.findUnique({ where: { id: input.phraseId }, select: { id: true } });
  if (!phrase) throw new FormalizationProbeServiceError('사전 항목을 찾을 수 없습니다');

  const hits = await prisma.learnedPhraseHit.findMany({
    where: { phraseId: input.phraseId, matchedSentence: { not: null } },
    select: { matchedSentence: true, verdict: true },
  });
  const sentences: ProbeSentence[] = [];
  for (const h of hits) {
    if (!h.matchedSentence) continue;
    if (h.verdict === 'REJECTED' || h.verdict === 'TAKEDOWN') sentences.push({ text: h.matchedSentence, kind: 'TP' });
    else if (h.verdict === 'APPROVED') sentences.push({ text: h.matchedSentence, kind: 'NORMAL' });
    // 판정 전·기타는 어느 쪽 증거도 아니다
  }
  for (const text of controlSentences()) sentences.push({ text, kind: 'NORMAL' });

  const result = runFormalizationProbe(input, sentences, now);
  await prisma.learnedPhrase.update({
    where: { id: input.phraseId },
    data: { formalizeProbeJson: JSON.stringify(result), formalizeProbeAt: now },
  });
  return result;
}
