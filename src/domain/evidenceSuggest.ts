// 근거 문장 추천 (12차 검토 C-3 수정 채택, 2026-09-01) — 순수 로직.
//
// 반려·철회 때 운영자가 본문(최대 1,000자)에서 근거 문장을 짚는다. 매번 손으로 찾게 두면
// 지쳐서 아무 문장이나 찍는 자기기만이 생기고(1인 운영), 그 라벨이 ARGOS 재학습에 섞인다.
// 그래서 **먼저 볼 문장**을 골라 준다 — 선택의 책임은 여전히 사람이고, 추천은 순서일 뿐이다.
//
// 근거는 둘뿐이다(검토자의 "임계치 미달 문장"은 규칙이 정규식이라 존재하지 않는다):
//   · 소견 인용문 — 규칙·사전이 이미 짚은 자리 (운영자가 이미 보는 값)
//   · 사전 표현 포함 — 서버에서만 맞춘다. 결과는 본문 문장이라 사전이 밖으로 새지 않는다
// 학생(ARGOS) 소견은 문장을 못 짚어 여기 없다 — 바로 그 경우가 사람이 짚어야 하는 자리다.

import { normalizeForRules } from './compliance';

export interface SuggestPhrase {
  normalized: string;
  category: string;
}

export interface EvidenceSuggestion {
  sentence: string;
  /** 왜 앞에 왔나 — 사전 표현 이름은 싣지 않는다(밖으로 새지 않게), 종류만 */
  reason: '소견' | '사전' | '소견·사전';
}

/** @근거 설계 추천 상한 — 5개면 훑어보고 고를 분량, 더 많으면 추천이 아니라 목록이다 */
export const EVIDENCE_SUGGEST_LIMIT = 5;
/** @근거 설계 문장 길이 하한 — 이보다 짧으면 제목·번호·꼬리표라 근거 문장이 되기 어렵다 */
export const EVIDENCE_MIN_SENTENCE = 8;

/** 문장 분리 — 마침표·물음표·느낌표 뒤 공백, 또는 줄바꿈. 중복 제거, 순서 유지 */
export function splitSentences(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/(?<=[.!?。])\s+|\n+/)) {
    const s = raw.trim();
    if (s.length < EVIDENCE_MIN_SENTENCE || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

const coreOf = (q: string) => q.replace(/^…|…$/g, '').trim();

export function rankEvidenceSentences(input: {
  content: string;
  phrases: SuggestPhrase[];
  quotes: string[];
  /** 운영자가 고른 유형 — 있으면 그 유형의 사전 표현만 본다 */
  categories?: string[];
  limit?: number;
}): EvidenceSuggestion[] {
  const cats = new Set(input.categories ?? []);
  const phrases = cats.size ? input.phrases.filter((p) => cats.has(p.category)) : input.phrases;
  const quotes = input.quotes.map(coreOf).filter((q) => q.length >= 6);
  const scored: Array<{ s: string; score: number; quote: boolean; phrase: boolean; i: number }> = [];
  splitSentences(input.content).forEach((s, i) => {
    const quote = quotes.some((q) => s.includes(q) || q.includes(s));
    const norm = normalizeForRules(s).text;
    const phrase = phrases.some((p) => p.normalized.length > 0 && norm.includes(p.normalized));
    const score = (quote ? 3 : 0) + (phrase ? 2 : 0);
    if (score > 0) scored.push({ s, score, quote, phrase, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, input.limit ?? EVIDENCE_SUGGEST_LIMIT).map((x) => ({
    sentence: x.s,
    reason: x.quote && x.phrase ? '소견·사전' : x.quote ? '소견' : '사전',
  }));
}
