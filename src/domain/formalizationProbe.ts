// 공식화 샌드박스 (12차 검토 C-4 채택, 2026-09-01) — 순수 로직.
//
// 졸업 = "코드로 못 적으니 ARGOS 로". 그 "못 적는다"를 사람의 20자 사유로 받으면 1인 운영에서
// 보일러플레이트가 된다("코드로 짤 수 없음"). 대신 **후보 표현/패턴을 실제로 돌려 본 숫자**를
// 받는다: 이 항목이 잡은 정탐 문장을 몇 개 잡고(놓치고), 정상 문장(오탐·경미로 승인된 것 +
// 대조군 54문장)을 몇 개 잘못 잡았나. 정탐을 놓쳤거나 정상을 잡았으면 **공식화 실패** —
// 졸업이 열린다. 둘 다 아니면 공식화가 됐다는 뜻이라 졸업이 아니라 규칙 승격감이다.
//
// 입력은 문자열(운영자) 또는 정규식(창업자용). 문자열은 규칙 엔진과 같은 정규화를 거쳐
// 부분 일치로 본다 — "원 금 보 장" 류 우회를 사전이 따라잡듯이.

import { normalizeForRules } from './compliance';

export interface ProbeSentence {
  text: string;
  /** TP = 사람이 위반으로 확정한 문장 (잡아야 한다) / NORMAL = 정상 문장 (잡으면 오탐) */
  kind: 'TP' | 'NORMAL';
}

export interface FormalizationProbeResult {
  pattern: string;
  isRegex: boolean;
  tpTotal: number;
  tpHit: number;
  tpMiss: number;
  normalTotal: number;
  /** 정상 문장을 잡은 수 = 오탐 */
  normalHit: number;
  /** ISO 시각 */
  at: string;
}

export class FormalizationProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormalizationProbeError';
  }
}

/** @근거 설계 패턴 길이 하한 — 한 글자 패턴은 모든 문장을 잡아 "실패"를 꾸밀 수 있다 */
export const PROBE_MIN_PATTERN_LENGTH = 2;

function buildMatcher(pattern: string, isRegex: boolean): (text: string) => boolean {
  const p = pattern.trim();
  if (p.length < PROBE_MIN_PATTERN_LENGTH) {
    throw new FormalizationProbeError(`패턴이 너무 짧습니다 (${PROBE_MIN_PATTERN_LENGTH}자 이상)`);
  }
  if (isRegex) {
    let re: RegExp;
    try {
      re = new RegExp(p, 'iu');
    } catch (e) {
      throw new FormalizationProbeError(`정규식이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
    return (text) => re.test(text);
  }
  // 문자열 — 규칙 엔진과 같은 정규화(공백·기호 제거)로 부분 일치
  const needle = normalizeForRules(p).text;
  if (needle.length < PROBE_MIN_PATTERN_LENGTH) {
    throw new FormalizationProbeError('정규화하면 남는 글자가 너무 적습니다');
  }
  return (text) => normalizeForRules(text).text.includes(needle);
}

/** 후보 패턴을 문장들에 돌린다. 순수 — 같은 입력이면 같은 출력 (at 만 주입) */
export function runFormalizationProbe(
  input: { pattern: string; isRegex: boolean },
  sentences: ProbeSentence[],
  now = new Date(),
): FormalizationProbeResult {
  const match = buildMatcher(input.pattern, input.isRegex);
  let tpTotal = 0;
  let tpHit = 0;
  let normalTotal = 0;
  let normalHit = 0;
  for (const s of sentences) {
    const hit = match(s.text);
    if (s.kind === 'TP') {
      tpTotal++;
      if (hit) tpHit++;
    } else {
      normalTotal++;
      if (hit) normalHit++;
    }
  }
  return {
    pattern: input.pattern.trim(),
    isRegex: input.isRegex,
    tpTotal,
    tpHit,
    tpMiss: tpTotal - tpHit,
    normalTotal,
    normalHit,
    at: now.toISOString(),
  };
}

/**
 * 공식화 실패 = 정탐을 놓쳤거나 정상 문장을 잡았다. 이것이 졸업의 관문이다.
 * 정탐 표본이 0 이면(한 번도 안 걸린 표현) 놓칠 것이 없어 오탐으로만 판정된다.
 */
export function probeFailed(r: FormalizationProbeResult): boolean {
  return r.tpMiss > 0 || r.normalHit > 0;
}

/** 저장된 JSON → 결과 (깨졌거나 없으면 null) */
export function parseProbe(json: string | null | undefined): FormalizationProbeResult | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<FormalizationProbeResult>;
    if (typeof v.pattern !== 'string' || typeof v.tpTotal !== 'number') return null;
    return v as FormalizationProbeResult;
  } catch {
    return null;
  }
}
