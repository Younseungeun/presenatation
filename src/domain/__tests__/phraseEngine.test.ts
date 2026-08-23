import { describe, expect, it } from 'vitest';
import { applyRules, decide, phraseToRule, type ScreeningInput } from '../compliance';
import { normalizePhrase, type LearnedPhrase } from '../learnedPhrases';
import { phoneticCollisions } from '../phoneticEvasion';

// **사전이 규칙 엔진의 입력이 된 뒤의 계약** (2026-08-21 창업자 확정 · 20차).
//
// 재던 구멍 그대로가 시험이 된다 — 별도 경로(indexOf) 시절 실측:
//   자모 분리 `ㅇ ㅝ ㄴ …`   → 사전만으로는 미탐   (3층을 못 받아서)
//   음성 변형 `원금보쟝`      → 사전만으로는 미탐   (5층을 못 받아서)
//   우연히 붙은 `복원. 금보장` → 사전만으로는 오탐   (간격 판별을 못 받아서)
// 합류 후에는 세 줄이 전부 뒤집혀야 한다.

const CARD = {
  assetClass: 'KR_EQUITY' as const,
  assetName: '삼성전자',
  direction: 'UP' as const,
  targetType: 'RETURN_PCT' as const,
  magnitudePct: 12,
  horizonDays: 90,
  confidence: 5,
};

const phrase = (text: string, over: Partial<LearnedPhrase> = {}): LearnedPhrase => ({
  id: `p-${text}`,
  phrase: text,
  normalized: normalizePhrase(text),
  category: 'UNSUPPORTED_CLAIM',
  note: null,
  phoneticEligible: false,
  ...over,
});

const screen = (content: string, phrases: LearnedPhrase[]) =>
  applyRules({ title: '', summary: '', content, ...CARD } as ScreeningInput, {
    knownNames: new Set<string>(),
    phrases,
  });

describe('사전 표현이 6층 해석을 받는다', () => {
  // 코드 규칙과 겹치지 않는 합성 표현으로 잰다 — 겹치면 어느 쪽이 잡았는지 모른다
  const P = [phrase('확실무적익절')];

  it('1층: 자연스러운 띄어쓰기를 잡는다 (구분기호 자리는 유연하게)', () => {
    const spaced = [phrase('확실 무적 익절')];
    const out = screen('이번 구간은 확실 무적 익절 자리입니다', spaced);
    expect(out.some((f) => f.source === 'learned' && f.layer === 'L1_RAW')).toBe(true);
  });

  it('2층: 일부러 벌린 표기를 잡는다 — 예전 별도 경로도 잡던 것', () => {
    const out = screen('확.실.무.적.익.절 갑니다', P);
    expect(out.some((f) => f.source === 'learned')).toBe(true);
  });

  it('3층: 자모로 풀어 쓴 회피를 잡는다 — **별도 경로 시절의 미탐**', () => {
    const out = screen('ㅎ ㅘ ㄱ ㅅ ㅣ ㄹ ㅁ ㅜ ㅈ ㅓ ㄱ ㅇ ㅣ ㄱ ㅈ ㅓ ㄹ 신호', P);
    expect(out.some((f) => f.source === 'learned' && f.layer === 'L3_DEEP')).toBe(true);
  });

  it('5층: 자격 있는 항목은 한 글자 바꾼 변형을 잡는다 — **별도 경로 시절의 미탐**', () => {
    const eligible = [phrase('확실무적익절', { phoneticEligible: true })];
    const out = screen('확실무적익졸 타이밍입니다', eligible);
    const hit = out.find((f) => f.layer === 'L5_PHONETIC');
    expect(hit?.source).toBe('learned');
    expect(hit?.phraseId).toBe('p-확실무적익절');
  });

  it('5층: 자격 없는 항목(충돌)은 변형을 잡지 않는다 — 정확 매칭만', () => {
    const out = screen('확실무적익졸 타이밍입니다', P);
    expect(out.filter((f) => f.layer === 'L5_PHONETIC')).toHaveLength(0);
  });

  it('소견 계약이 유지된다: source=learned · phraseId · WARN · 층 태그 (Q4·Q5)', () => {
    const out = screen('확실무적익절 구간입니다', P);
    const f = out.find((x) => x.source === 'learned');
    expect(f).toMatchObject({
      severity: 'WARN', // 사전은 어느 층에서 잡혀도 WARN — 즉시 거절은 코드 원천만
      phraseId: 'p-확실무적익절',
    });
    expect(f?.layer).toBeDefined();
    expect(f?.quote).toContain('확실무적익절');
  });

  it('사전 소견은 즉시 거절을 만들 수 없다', () => {
    expect(decide(screen('확실무적익절 구간입니다', P))).toBe('WARN');
  });
});

describe('phraseToRule — 패턴 변환', () => {
  it('운영자가 쓴 구분기호 자리만 유연해진다 — 붙여 쓴 표현은 글자 그대로', () => {
    const tight = phraseToRule(phrase('확실무적익절'));
    expect(tight.pattern.test('확실무적익절')).toBe(true);
    // 붙여 등록한 표현은 1층에서 벌린 표기와 안 맞는다 — 그건 2층(간격 판별)의 몫이다
    expect(tight.pattern.test('확실 무적 익절')).toBe(false);
  });

  it('정규식 특수문자가 든 표현도 안전하다 — 운영자 입력이 패턴 문법이 되면 안 된다', () => {
    const r = phraseToRule(phrase('수익 100% (확정)'));
    expect(r.pattern.test('수익 100% (확정) 입니다')).toBe(true);
  });
});

describe('등록 충돌 검사 (20차 X-1)', () => {
  it('정상 낱말의 자모 거리-1 안이면 충돌로 잡는다', () => {
    // 원금보졸 ↔ 원금보존: 졸(ㅈㅗㄹ)/존(ㅈㅗㄴ) — 자모 1
    const out = phoneticCollisions('원금보졸', ['원금보존'], []);
    expect(out.some((c) => c.against === '원금보존')).toBe(true);
  });

  it('거리 밖이면 충돌이 아니다 — 상한 1의 눈금 그대로', () => {
    // 수익보장 ↔ 수익보전: 장/전 이 자모 2 — 상한 1에서는 이웃이 아니다
    expect(phoneticCollisions('수익보장', ['수익보전'], [])).toHaveLength(0);
  });

  it('정상 문장 코퍼스에서도 잡는다 — 낱말 목록에 없는 표기가 걸리는 자리', () => {
    const out = phoneticCollisions('원금보졸', [], ['원금보존추구형 상품과 비교했습니다']);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].kind).toBe('corpus');
  });

  it('포함 관계는 충돌이 아니다 — 매처가 정확 포함에 침묵하므로 안전하다', () => {
    expect(phoneticCollisions('원금보존', ['원금보존추구형'], [])).toHaveLength(0);
  });
});
