import { describe, expect, it } from 'vitest';
import { COHERENCE_CORPUS } from '../__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '../__fixtures__/screeningCorpus';
import { applyRules, type Finding, type ScreeningInput } from '../compliance';
import { corpusInput, evaluate } from '../screeningEval';

// 검수 성능의 회귀 방지선.
//
// 여기 수치는 손으로 만든 부트스트랩 코퍼스 기준이라 절대값에 의미를 두지 않는다.
// 다만 **떨어지면 안 되는 성질**은 테스트로 못 박는다 — 특히 즉시 거절 오탐 0건.

/** 문장 하나를 검수 입력으로 감싼다 (카드 없음 — 문장 단위 항목의 기본값과 같다) */
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

const report = evaluate((input) => applyRules(input), SCREENING_CORPUS);
const coherence = evaluate((input) => applyRules(input), COHERENCE_CORPUS);

// corpusInput이 문장 항목에 채우는 기본 카드는 **어떤 규칙도 건드리지 않아야** 한다.
// 여기서 소견이 나오면 카드 규칙이 문장 기준선에 섞여 들어와 기존 수치가 흔들린다.
describe('평가 하네스', () => {
  it('문장 항목의 기본 카드는 어떤 소견도 만들지 않는다', () => {
    const input = corpusInput({ text: '평범한 분석 문장입니다.', violation: null, kind: 'normal' });
    expect(applyRules(input)).toHaveLength(0);
  });
});

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

// ── 문서 단위 기준선 (본문 ↔ 카드 정합성) ─────────────────────────────
//
// 이 묶음이 지키는 것은 탐지율이 아니다. **규칙이 이 판단에 손대지 않는다**는 것이다.
// 본문과 카드의 논조 모순을 정규식으로 잡으려 들면(어휘 세기) 반대 시나리오를 충실히
// 쓴 정상 리포트가 무더기로 걸린다. 그 시도를 여기서 막는다.
describe('문서 단위 기준선 (본문 ↔ 카드 정합성)', () => {
  it('리스크를 길게 다뤄도 결론이 카드와 같으면 건드리지 않는다', () => {
    // 최우선 하드 네거티브. 여기가 걸리기 시작하면 성실하게 쓴 리서처일수록 더 막힌다.
    const riskHeavy = coherence.byKind.find((k) => k.kind === 'risk_heavy');
    const coherent = coherence.byKind.find((k) => k.kind === 'coherent');
    expect(riskHeavy?.hit).toBe(0);
    expect(coherent?.hit).toBe(0);
  });

  it('문서 단위에서도 즉시 거절 오탐은 0이다', () => {
    expect(coherence.blockingFalsePositives).toBe(0);
  });

  it('규칙이 잡는 것은 **결론부의 방향 충돌**뿐이다 (9차 G-6)', () => {
    // 이전에는 이 값이 0이었고 "규칙은 본문-카드 모순을 못 잡는다"를 못 박고 있었다.
    // 9차에 그 진술을 좁혔다: **본문 전체**로는 여전히 못 잡지만(정상 리포트는 원래
    // 반대 시나리오를 길게 쓴다), **제목·요약**은 리서처의 최종 결론만 적는 자리라
    // 거기서 카드와 반대인 것은 시나리오가 아니라 모순이다.
    //
    // 숫자 하나를 박지 않고 **모양**을 박는다 — 값은 코퍼스가 늘면 움직이지만
    // 아래 세 성질은 구조에서 나오므로 움직이면 그것이 곧 결함이다.
    const byKind = (k: string) => coherence.byKind.find((x) => x.kind === k)!;

    // ① 방향 충돌은 잡기 시작했다
    expect(byKind('direction_flip').hit).toBeGreaterThan(0);

    // ② **크기·기간 어긋남은 여전히 0이다.** 어휘로는 "18%인데 5% 라고 썼다"를 알 수 없다.
    //    이 자리는 NLI 교차 인코더의 몫으로 남는다 — 0이 아니게 되는 날은
    //    무엇이 그것을 채웠는지 먼저 밝힐 것.
    expect(byKind('magnitude_gap').hit).toBe(0);
    expect(byKind('horizon_gap').hit).toBe(0);

    // ③ 전체는 여전히 낮다. 이 규칙은 문서 판정을 **대체하지 않는다**
    expect(coherence.recall).toBeLessThan(0.5);
  });

  it('세 가지 어긋남을 모두 표본에 갖고 있다', () => {
    // 합쳐서 세면 "방향은 잡는데 기간은 전혀 못 본다"가 숨는다.
    for (const kind of ['direction_flip', 'magnitude_gap', 'horizon_gap'] as const) {
      expect(coherence.byKind.find((k) => k.kind === kind)!.total).toBeGreaterThan(0);
    }
  });

  it('정상 표본의 과반이 하드 네거티브다', () => {
    // 쉬운 정상 문항만 채우면 오탐률이 낮게 나와 모델을 잘못 채택하게 된다.
    const riskHeavy = coherence.byKind.find((k) => k.kind === 'risk_heavy')!.total;
    expect(riskHeavy * 2).toBeGreaterThan(coherence.negatives);
  });
});

// ── 위험 성격별 계측 ──────────────────────────────────────────────────
//
// 2026-08-19 외부 검토 지적을 수용해 추가. 총합 탐지율 하나는 "규제 위반만 골라 새고
// 있는" 상태를 가린다 — 근거 없는 단정을 놓치는 것과 손실보전 약속을 놓치는 것이
// 같은 1건으로 세지기 때문이다. 처방은 거절을 늘리는 것이 아니라 **따로 재는 것**이다.
describe('위험 성격별 계측', () => {
  it('규제 유형의 탐지율을 따로 낸다', () => {
    const regulatory = report.byTier.find((t) => t.tier === 'REGULATORY');
    expect(regulatory).toBeDefined();
    expect(regulatory!.total).toBeGreaterThan(0);
  });

  it('보류율은 즉시 거절을 세지 않는다 — 큐에 오지 않기 때문', () => {
    // 지금은 거절 오탐이 0이라 오탐률과 같은 값이다. 두 값이 갈라지는 날이
    // 정상 리포트가 사람 확인 없이 죽기 시작하는 날이므로, 갈라지는 것을 봐야 한다.
    expect(report.holdRate).toBeLessThanOrEqual(report.falsePositiveRate);
    expect(report.holdRate).toBe(report.falsePositiveRate - report.blockingFalsePositives / report.negatives);
  });
});

// ── 관측 전용 항목 ────────────────────────────────────────────────────
//
// 정답이 정해지지 않은 경계 사례. 채점에서 빼는 이유는 라벨을 붙이는 순간
// 그 임의의 판단이 곧 채택선이 되기 때문이다. 탐지기의 답만 기록한다.
describe('관측 전용(probe) 항목', () => {
  it('채점 분모에 들어가지 않는다', () => {
    const scored = COHERENCE_CORPUS.filter((i) => !i.probe).length;
    expect(coherence.total).toBe(scored);
    expect(coherence.violations + coherence.negatives).toBe(scored);
  });

  it('그래도 결과는 보고된다 — 관측이 목적이므로', () => {
    const probeCount = COHERENCE_CORPUS.filter((i) => i.probe).length;
    expect(coherence.probes).toHaveLength(probeCount);
    expect(probeCount).toBeGreaterThan(0);
  });
});

// ── 하드 네거티브를 흉내낸 위반 ───────────────────────────────────────
//
// 2026-08-19 3차 검토가 가리킨 빈 칸. risk_heavy를 봐주도록 배운 탐지기는
// "리스크 문단을 길게 깔면 카드를 뒤집어도 통과"시킨다. 그 구멍이 지표에 잡히게 한다.
describe('리스크로 위장한 모순', () => {
  it('표본에 존재한다 — 없으면 그 구멍이 영원히 안 보인다', () => {
    const flip = coherence.byKind.find((k) => k.kind === 'flip_under_risk');
    expect(flip?.total).toBeGreaterThan(0);
  });

  it('정상 risk_heavy와 따로 센다', () => {
    // 합쳐 세면 "평범한 모순은 잡는데 위장한 모순은 놓친다"가 숨는다
    const flip = coherence.byKind.find((k) => k.kind === 'flip_under_risk');
    const heavy = coherence.byKind.find((k) => k.kind === 'risk_heavy');
    expect(flip).toBeDefined();
    expect(heavy).toBeDefined();
    expect(flip!.kind).not.toBe(heavy!.kind);
  });
});
