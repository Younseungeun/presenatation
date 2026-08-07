import { describe, expect, it } from 'vitest';
import { SCREENING_CORPUS } from '../__fixtures__/screeningCorpus';
import { applyRules, type Finding, type ScreeningInput } from '../compliance';
import { evaluate } from '../screeningEval';

// 검수 성능의 회귀 방지선.
//
// 여기 수치는 손으로 만든 부트스트랩 코퍼스 기준이라 절대값에 의미를 두지 않는다.
// 다만 **떨어지면 안 되는 성질**은 테스트로 못 박는다 — 특히 즉시 거절 오탐 0건.

function detect(text: string): Finding[] {
  const input: ScreeningInput = {
    title: '',
    summary: '',
    content: text,
    assetClass: 'KR_EQUITY',
    assetName: '',
    direction: 'UP',
  };
  return applyRules(input);
}

const report = evaluate(detect, SCREENING_CORPUS);

describe('검수 기준선 (결정적 규칙)', () => {
  it('정상 문장을 즉시 거절하지 않는다', () => {
    // 가장 중요한 성질. 보류 오탐은 운영자가 승인으로 되살릴 수 있지만,
    // 거절 오탐은 사람 확인 없이 정상 리포트를 죽인다.
    // (평가셋을 만들자마자 여기서 실제 결함이 발견됐다 — "과거 수익률이 미래 수익을
    //  보장하지 않습니다" 같은 표준 면책 문구가 BLOCK으로 즉시 거절되고 있었다)
    expect(report.blockingFalsePositives).toBe(0);
  });

  it('평범한 분석 문장과 리스크 고지 문구는 건드리지 않는다', () => {
    const normal = report.byKind.find((k) => k.kind === 'normal');
    const disclosure = report.byKind.find((k) => k.kind === 'disclosure');
    expect(normal?.hit).toBe(0);
    expect(disclosure?.hit).toBe(0);
  });

  it('금지 표현을 그대로 쓴 문장은 대부분 잡는다', () => {
    expect(report.byKind.find((k) => k.kind === 'literal')!.rate).toBeGreaterThanOrEqual(0.85);
  });

  it('글자를 벌린 회피 표현도 잡는다', () => {
    expect(report.byKind.find((k) => k.kind === 'evasion')!.rate).toBe(1);
  });

  it('전체 오탐률이 기준선 아래를 유지한다', () => {
    expect(report.falsePositiveRate).toBeLessThanOrEqual(0.2);
  });

  it('패러프레이즈는 원리적으로 못 잡는다 — 이 격차가 모델이 메울 몫', () => {
    // 이 값이 0이 아니게 되는 날은 규칙이 똑똑해진 게 아니라
    // 정규식이 넓어져 오탐을 함께 늘렸을 가능성이 크다. 그때 오탐률도 같이 확인할 것.
    expect(report.byKind.find((k) => k.kind === 'paraphrase')!.rate).toBeLessThan(0.1);
  });
});

describe('부정 문맥 처리', () => {
  const severities = (text: string) => detect(text).map((f) => f.severity);

  it('주장 동사에 직접 붙은 부정은 지적하지 않는다', () => {
    // 표준 면책 문구 — 여기서 소견이 나오면 정상 리포트가 전부 걸린다
    expect(detect('과거 수익률이 미래 수익을 보장하지 않습니다.')).toHaveLength(0);
    expect(detect('1:1 상담은 제공하지 않습니다.')).toHaveLength(0);
    expect(detect('빚투는 절대 권하지 않습니다.')).toHaveLength(0);
  });

  it('부정이 멀리 있으면 소견은 내되 즉시 거절로 가지 않는다', () => {
    // "원금 보장은 어떤 경우에도 약속드릴 수 없습니다" — 부정이 주장 동사에 붙어 있지
    // 않아 확신할 수 없다. 사람이 읽고 판단하도록 보류시킨다.
    expect(severities('원금 보장은 어떤 경우에도 약속드릴 수 없습니다.')).toEqual(['WARN']);
  });

  it('부정 어휘가 섞여도 실제 위반은 놓치지 않는다', () => {
    // "손해 볼 일이 없습니다"의 '없'은 부정 어휘지만 주장을 뒤집지 않는다.
    // 심각도는 낮아지되 소견 자체는 남아 운영자 큐에 오른다.
    const findings = detect('이 종목은 원금 보장이 되는 구조라 손해 볼 일이 없습니다.');
    expect(findings.map((f) => f.category)).toContain('PROFIT_GUARANTEE');
  });

  it('부정이 없는 직설 위반은 그대로 즉시 거절이다', () => {
    expect(severities('제 리포트대로만 하시면 수익을 보장합니다.')).toContain('BLOCK');
  });
});
