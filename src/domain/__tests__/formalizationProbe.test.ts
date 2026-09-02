import { describe, expect, it } from 'vitest';
import {
  FormalizationProbeError,
  parseProbe,
  probeFailed,
  runFormalizationProbe,
  type ProbeSentence,
} from '../formalizationProbe';

// 공식화 샌드박스 (12차 검토 C-4, 2026-09-01) — 졸업 관문의 "코드로 못 적는가"를 숫자로 받는다.

const S: ProbeSentence[] = [
  { text: '이 종목은 원금 보장 상품처럼 안전합니다', kind: 'TP' },
  { text: '원 금 보 장 됩니다 걱정 마세요', kind: 'TP' }, // 띄운 우회 — 정규화로 잡혀야
  { text: '손실은 없다고 보셔도 됩니다', kind: 'TP' }, // 다른 낱말 — 문자열로는 못 잡음
  { text: '원금 보장 상품이 아니므로 손실이 날 수 있습니다', kind: 'NORMAL' }, // 부정문 — 문자열은 오탐
  { text: '과거 수익률은 미래를 보장하지 않습니다', kind: 'NORMAL' },
];

describe('runFormalizationProbe', () => {
  it('문자열은 규칙 엔진과 같은 정규화로 부분 일치 — 띄운 우회를 잡고, 다른 낱말은 놓치고, 부정문은 오탐', () => {
    const r = runFormalizationProbe({ pattern: '원금 보장', isRegex: false }, S, new Date('2026-09-01T00:00:00Z'));
    expect(r).toMatchObject({ tpTotal: 3, tpHit: 2, tpMiss: 1, normalTotal: 2, normalHit: 1, at: '2026-09-01T00:00:00.000Z' });
    expect(probeFailed(r)).toBe(true); // 놓친 것도 있고 오탐도 있다 → 공식화 실패 = 졸업 가능
  });

  it('정규식은 그대로 돈다 — 부정문을 비껴가는 조건이면 오탐 0', () => {
    const r = runFormalizationProbe(
      { pattern: '원\\s*금\\s*보\\s*장(?!\\s*상품이 아니)', isRegex: true },
      S,
    );
    expect(r.normalHit).toBe(0);
    expect(r.tpHit).toBe(2);
    expect(r.tpMiss).toBe(1); // "손실은 없다"는 여전히 못 잡는다 → 실패
    expect(probeFailed(r)).toBe(true);
  });

  it('다 잡고 정상은 안 잡으면 공식화 성공 — 졸업이 아니라 승격감', () => {
    const only = S.filter((s) => s.text.includes('원') || s.kind === 'NORMAL');
    const r = runFormalizationProbe({ pattern: '원\\s*금\\s*보\\s*장(?!\\s*상품이 아니)', isRegex: true }, only);
    expect(r.tpMiss).toBe(0);
    expect(r.normalHit).toBe(0);
    expect(probeFailed(r)).toBe(false);
  });

  it('너무 짧은 패턴·잘못된 정규식은 거절한다 — 한 글자로 "실패"를 꾸밀 수 없다', () => {
    expect(() => runFormalizationProbe({ pattern: '원', isRegex: false }, S)).toThrow(FormalizationProbeError);
    expect(() => runFormalizationProbe({ pattern: '(원금', isRegex: true }, S)).toThrow(FormalizationProbeError);
  });

  it('정탐 표본이 없으면 오탐으로만 판정된다', () => {
    const r = runFormalizationProbe({ pattern: '보장', isRegex: false }, S.filter((s) => s.kind === 'NORMAL'));
    expect(r.tpTotal).toBe(0);
    expect(r.normalHit).toBe(2);
    expect(probeFailed(r)).toBe(true);
  });
});

describe('parseProbe', () => {
  it('저장된 JSON 을 되돌리고, 없거나 깨졌으면 null', () => {
    const r = runFormalizationProbe({ pattern: '원금 보장', isRegex: false }, S);
    expect(parseProbe(JSON.stringify(r))).toEqual(r);
    expect(parseProbe(null)).toBeNull();
    expect(parseProbe('{')).toBeNull();
    expect(parseProbe('{"pattern":1}')).toBeNull();
  });
});
