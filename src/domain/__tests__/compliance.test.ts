import { describe, expect, it } from 'vitest';
import { applyRules, blocksPublish, decide, mergeFindings, type ScreeningInput } from '../compliance';

// 결정적 규칙은 오탐이 사실상 없어야 한다 — 정상 리서처의 게시를 막으면
// 공급 확보(1단계 전략)가 무너지기 때문. 그 균형을 테스트로 고정한다.

function input(over: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    title: '삼성전자 목표주가 상향',
    summary: '반도체 업황 개선으로 상승 여력이 있다고 판단합니다.',
    content: '3분기 실적과 공시 자료를 근거로 목표주가를 9만원으로 제시합니다.',
    assetClass: 'KR_EQUITY',
    assetName: '삼성전자',
    direction: 'UP',
    ...over,
  };
}

describe('applyRules — 명백한 금지 표현 차단', () => {
  it('수익·원금 보장 표현은 BLOCK', () => {
    const f = applyRules(input({ content: '이 종목은 원금 보장 수준으로 안전합니다.' }));
    expect(f[0]).toMatchObject({ category: 'PROFIT_GUARANTEE', severity: 'BLOCK' });
    expect(f[0].quote).toContain('원금 보장');

    expect(applyRules(input({ content: '무조건 오릅니다.' }))[0].severity).toBe('BLOCK');
    expect(applyRules(input({ summary: '100% 수익 보장' }))[0].category).toBe('PROFIT_GUARANTEE');
  });

  it('1:1 상담·외부 채널 유도는 BLOCK (투자자문업 경계)', () => {
    const f = applyRules(input({ content: '자세한 건 오픈채팅방으로 문의주세요.' }));
    expect(f[0]).toMatchObject({ category: 'SOLICIT_CONTACT', severity: 'BLOCK' });

    expect(applyRules(input({ content: '텔레그램 리딩방 운영 중' }))[0].category).toBe(
      'SOLICIT_CONTACT',
    );
    expect(applyRules(input({ content: '개인 상담 원하시면 연락주세요' }))[0].severity).toBe(
      'BLOCK',
    );
  });

  it('미공개 중요정보 정황은 BLOCK', () => {
    const f = applyRules(input({ content: '내부 관계자에게 들은 바로는 실적이 좋습니다.' }));
    expect(f[0]).toMatchObject({ category: 'PRIVATE_INFO', severity: 'BLOCK' });
  });

  it('풍문성 표현은 WARN (게시는 허용, 운영자 검토)', () => {
    const f = applyRules(input({ content: '시장에 카더라가 돌고 있습니다.' }));
    expect(f[0]).toMatchObject({ category: 'RUMOR', severity: 'WARN' });
    expect(blocksPublish(decide(f))).toBe(false);
  });

  it('정상적인 투자 분석은 지적하지 않는다 (오탐 방지)', () => {
    expect(applyRules(input())).toEqual([]);
    // 강한 확신·목표가 제시·매수 의견은 전부 정상
    expect(
      applyRules(
        input({
          content:
            '강력히 매수 추천합니다. 목표수익률 30%를 제시하며, 저평가 구간이라고 판단합니다. 실적 발표 후 상승할 것으로 전망합니다.',
        }),
      ),
    ).toEqual([]);
    // 리스크 고지 문구도 정상
    expect(
      applyRules(input({ content: '투자 손실 가능성이 있으며 판단의 책임은 본인에게 있습니다.' })),
    ).toEqual([]);
  });
});

describe('decide — 결정 규칙', () => {
  it('BLOCK 하나라도 있으면 차단, WARN만 있으면 통과', () => {
    expect(decide([])).toBe('PASS');
    expect(decide([{ category: 'RUMOR', severity: 'WARN', quote: 'q', reason: 'r' }])).toBe('WARN');
    expect(
      decide([
        { category: 'RUMOR', severity: 'WARN', quote: 'q', reason: 'r' },
        { category: 'PROFIT_GUARANTEE', severity: 'BLOCK', quote: 'q', reason: 'r' },
      ]),
    ).toBe('BLOCK');
    expect(blocksPublish('UNAVAILABLE')).toBe(false); // 검수 장애는 게시를 막지 않는다
  });
});

describe('mergeFindings — 규칙 + AI 병합', () => {
  it('같은 카테고리·심각도는 규칙 결과만 남긴다', () => {
    const rule = [{ category: 'RUMOR' as const, severity: 'WARN' as const, quote: '규칙', reason: 'r' }];
    const ai = [
      { category: 'RUMOR' as const, severity: 'WARN' as const, quote: 'AI', reason: 'r' },
      { category: 'UNSUPPORTED_CLAIM' as const, severity: 'WARN' as const, quote: 'AI2', reason: 'r' },
    ];
    const merged = mergeFindings(rule, ai);
    expect(merged).toHaveLength(2);
    expect(merged[0].quote).toBe('규칙');
    expect(merged[1].category).toBe('UNSUPPORTED_CLAIM');
  });
});
