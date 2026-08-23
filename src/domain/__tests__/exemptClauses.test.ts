import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRules } from '../compliance';
import type { ScreeningInput } from '../compliance';
import { EXEMPT_EXACT_CLAUSES, validateExemptClause } from '../exemptClauses';
import { REGRESSION_SEED_CORPUS, SCORING_CORPUS } from '../__fixtures__/screeningCorpus';

// **면제 구문(24차 AA-2)과 날짜 전방 탐색(AA-3)의 시험.**
//
// 면제는 즉시 거절(REJECT)에 구멍을 내는 유일한 장치다 — 그래서 시험이 지키는 것은
// "면제가 잘 된다"가 아니라 **"면제가 여기서 한 발짝도 더 못 나간다"**이다.

function input(content: string): ScreeningInput {
  return {
    title: '',
    summary: '',
    content,
    assetClass: 'KR_EQUITY',
    assetName: '',
    direction: 'UP',
  } as ScreeningInput;
}

describe('완전 일치 면제 구문 (24차 AA-2 실물)', () => {
  it('DART 퇴직연금 회계 서술은 침묵한다 — 즉시 거절 오탐의 첫 실물', () => {
    const f = applyRules(
      input('당사가 가입한 퇴직연금은 원금이 보장되며, 확정급여제도의 운영으로 지급이 이루어집니다.'),
    );
    expect(f.filter((x) => x.category === 'PROFIT_GUARANTEE')).toHaveLength(0);
  });

  it('**면제 구문 밖으로 이어지는 위반은 그대로 잡는다** — 25차 gap 17형 방어', () => {
    // "정당한 팩트 + 교묘한 위반"을 한 문장에 붙인 역용 — 면제가 겹치기만 해도
    // 발동하는 방식이었다면 이 문장이 통째로 지워졌다
    const f = applyRules(input('퇴직연금은 원금이 보장되며 제 전략도 원금을 보장해 드립니다.'));
    expect(f.some((x) => x.category === 'PROFIT_GUARANTEE' && x.severity === 'BLOCK')).toBe(true);
  });

  it('등재 목록 전체가 절 단위 형태 요건을 지킨다 — 단편 등재는 컴파일 전에 걸린다', () => {
    for (const clause of EXEMPT_EXACT_CLAUSES) {
      expect(validateExemptClause(clause)).toBeNull();
    }
    expect(validateExemptClause('퇴직연금은')).not.toBeNull();
    expect(validateExemptClause('원금 보장')).not.toBeNull();
  });

  it('**등재 전수 검사** — 어떤 위반 코퍼스 문장에도 면제 구문이 들어 있지 않다', () => {
    // 구문이 위반 문장에 없으면 가릴 위반도 없다 — 탐지율 하락이 원리적으로 불가능해지는
    // 조건이고, 미래의 등재가 이 성질을 깨면 이 시험이 CI 에서 막는다 (25차 BB-2 ③).
    const texts: string[] = [
      ...SCORING_CORPUS.filter((c) => c.violation !== null).map((c) => c.text),
      ...REGRESSION_SEED_CORPUS.filter((c) => c.violation !== null).map((c) => c.text),
    ];
    for (const file of ['synth-holdout.jsonl', 'evasion-founder-1.jsonl']) {
      const raw = readFileSync(join(process.cwd(), 'training', 'holdout', file), 'utf-8');
      for (const line of raw.split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as { text: string; labels?: string[] };
        if ((row.labels ?? []).length > 0) texts.push(row.text);
      }
    }
    expect(texts.length).toBeGreaterThan(50);
    for (const clause of EXEMPT_EXACT_CLAUSES) {
      const hit = texts.find((t) => t.includes(clause));
      expect(hit, `면제 구문 "${clause}" 이 위반 문장에 들어 있습니다 — 등재 거부`).toBeUndefined();
    }
  });
});

describe('날짜 전방 탐색 (24차 AA-3 — 한글 숫자어 규칙의 날짜 오탐)', () => {
  it('날짜·서식 문장은 침묵한다 — DART 오탐 4건 계열의 실물', () => {
    const f = applyRules(input('배당기준일은 2026년 03월 26일이며, 제10기 정기주주총회에서 확정됩니다.'));
    expect(f.filter((x) => x.category === 'SOLICIT_CONTACT')).toHaveLength(0);
  });

  it('한글 숫자어 회피는 그대로 잡는다 — 전방 탐색이 탐지를 깎지 않았다', () => {
    const f = applyRules(input('궁금하신 분은 팔구23 으로 문자 주세요.'));
    expect(f.some((x) => x.category === 'SOLICIT_CONTACT')).toBe(true);
  });

  it('역추적이 전방 탐색을 우회하지 못한다 — 숫자 덩어리 끝이 고정된다', () => {
    // (?!\d) 가 없으면 `2026`을 `202`로 줄여 "6이 날짜 단위가 아니다"로 통과한다
    const f = applyRules(input('일이삼 2026년에 발표된 자료입니다.'));
    expect(f.filter((x) => x.category === 'SOLICIT_CONTACT')).toHaveLength(0);
  });
});
