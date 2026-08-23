import { describe, expect, it } from 'vitest';
import { applyRules, decide, type ScreeningInput } from '../compliance';
import { normalizePhrase, type LearnedPhrase } from '../learnedPhrases';

// **부정 문맥 가드** (2026-08-21 실측으로 드러난 결함 셋).
//
// 세 시험이 서로 다른 고장을 붙잡는다. 셋 다 실제로 뚫려 있었다:
//
//   ① 존댓말이 부정 어휘 목록을 무력화했다      → 정상 면책 문장이 **즉시 거절**
//   ② 첫 매칭이 부정문이면 규칙을 통째로 포기했다 → 부정문 한 줄로 **완전 우회**
//   ③ 학습 표현 사전은 이 검사를 아예 안 지났다   → 등록한 표현의 부정문도 보류
//
// ①과 ③은 오탐(λ=4 에서 가장 비싸다), ②는 미탐이다. 방향이 반대라 한 시험으로 묶으면
// 한쪽을 고치다 다른 쪽을 열어도 초록이 된다.

const CARD = {
  assetClass: 'KR_EQUITY' as const,
  assetName: '삼성전자',
  direction: 'UP' as const,
  targetType: 'RETURN_PCT' as const,
  magnitudePct: 12,
  horizonDays: 90,
  confidence: 5,
};

const screen = (content: string) =>
  applyRules({ title: '', summary: '', content, ...CARD } as ScreeningInput, {
    knownNames: new Set<string>(),
  });

const PHRASE: LearnedPhrase = {
  id: 'p1',
  phrase: '원금 보장',
  normalized: normalizePhrase('원금 보장'),
  category: 'PROFIT_GUARANTEE',
  note: null,
  phoneticEligible: false,
};

// 사전은 이제 규칙 엔진의 입력이다 (20차) — 같은 함수, 같은 가드
const withPhrase = (content: string) =>
  applyRules({ title: '', summary: '', content, ...CARD } as ScreeningInput, {
    knownNames: new Set<string>(),
    phrases: [PHRASE],
  });

describe('① 존댓말 부정 — 정상 면책 문장은 즉시 거절되지 않는다', () => {
  // 실측: 아래 넷이 전부 BLOCK 이었다. `아니` 는 `아니다` 만 잡고 `아닙니다` 를 놓치고
  // (`-ㅂ니다` 가 받침으로 녹는다), `불가능`·`어렵`·`힘들` 은 목록에 아예 없었다.
  // **리포트는 전부 존댓말로 쓴다** — 즉 목록의 절반이 실제 문장에서 죽어 있었다
  it.each([
    '원금 보장은 불가능합니다',
    '원금 보장은 어렵습니다',
    '이 리포트는 원금 보장 상품이 아닙니다',
    '원금 보장을 기대하기 힘든 국면입니다',
    '어떤 리포트도 원금 보장을 뜻하지 않습니다',
  ])('"%s" 는 즉시 거절되지 않는다', (s) => {
    expect(decide(screen(s)), s).not.toBe('BLOCK');
  });

  it('약속을 부인하는 형태는 보류까지 내려온다 — 거절은 아니다', () => {
    // `없습니` 가 매칭에서 9자 뒤라 STRONG 창(8자) 밖이다. WEAK 로 잡혀 강등된다 —
    // 사람이 보면 되는 자리라 여기서 멈춘다. 창을 넓히면 "원금 보장, 손실 걱정
    // 없습니다"(진짜 위반)까지 침묵하므로 넓히지 않는다
    expect(decide(screen('원금 보장을 약속드릴 수 없습니다'))).toBe('WARN');
  });
});

describe('② 부정문 방패 — 앞에 부정문을 깔아도 뒤의 위반이 잡힌다', () => {
  // 실측: 셋 다 **소견 0건으로 게시**됐다. `firstUnmaskedMatch` 가 첫 매칭만 돌려주고
  // 호출부가 그것을 보고 `continue` 해서 규칙을 통째로 포기했기 때문이다.
  // 15차에 종목명 마스킹에서 같은 실수를 하고 그 함수를 만들었는데, 부정 문맥에는
  // 그 교훈이 적용되지 않은 채 남아 있었다
  it.each([
    '원금 보장을 약속드리지 않습니다. 다만 원금 보장에 준하는 구조입니다',
    '원금 보장은 하지 않습니다 저희는 원금 보장을 확실히 해드립니다',
    '수익을 보장하지 않습니다 그러나 수익을 보장하는 전략입니다',
  ])('"%s" 는 통과하지 않는다', (s) => {
    expect(decide(screen(s)), s).not.toBe('PASS');
  });

  it('부정문만 있으면 그대로 통과한다 — 방패를 막느라 면책을 죽이지 않는다', () => {
    expect(decide(screen('원금 보장을 약속드리지 않습니다'))).toBe('PASS');
  });
});

describe('③ 학습 표현도 같은 가드를 지난다', () => {
  it('등록한 표현이라도 부정 문맥이면 소견을 내지 않는다', () => {
    // 사장님이 든 바로 그 예 — `원금 보장` 을 등록해 두면 그 표현을 **부인하는** 문장까지
    // 걸렸다. 사전은 `indexOf` 한 줄이라 문맥을 전혀 못 봤다
    expect(withPhrase('원금 보장은 불가능합니다')).toHaveLength(0);
  });

  it('부정문 뒤에 진짜 위반이 오면 사전도 잡는다 — 첫 자리에서 포기하지 않는다', () => {
    const out = withPhrase('원금 보장은 불가능합니다. 다만 저희는 원금 보장을 해드립니다');
    expect(out.some((f) => f.source === 'learned')).toBe(true);
  });

  it('평범한 위반은 그대로 잡는다', () => {
    const out = withPhrase('이 전략은 원금 보장이 됩니다');
    expect(out.some((f) => f.source === 'learned')).toBe(true);
  });
});
