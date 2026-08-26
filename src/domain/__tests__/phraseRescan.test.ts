import { describe, expect, it } from 'vitest';
import type { RegisteredPhrase, ScreeningInput } from '../compliance';
import { rescanForPhrase, type RescanTarget } from '../phraseRescan';

/**
 * **새 표현으로 게시 중 리포트를 다시 훑는다** (2026-08-25 창업자 확정).
 *
 * 학습 표현은 지금까지 **앞으로 올라올 글에만** 닿았다. 이미 팔리는 글에는 영원히
 * 닿지 않았고, 위험이 큰 쪽은 오히려 그쪽이다.
 *
 * 이 시험이 지키는 것은 **범위**다: 새 표현이 잡은 것만 나와야 한다. 전체 기준으로
 * 다시 훑으면 운영자가 이미 "괜찮다"고 넘긴 건이 표현을 등록할 때마다 또 뜨고,
 * 그러면 목록이 곧 배경음이 된다.
 */

function target(id: string, content: string): RescanTarget {
  return {
    reportId: id,
    input: {
      title: '삼성전자 목표주가 상향',
      summary: '반도체 업황 개선을 봅니다.',
      content,
      assetClass: 'KR_EQUITY',
      assetName: '삼성전자',
      direction: 'UP',
    } as ScreeningInput,
  };
}

function phrase(over: Partial<RegisteredPhrase> = {}): RegisteredPhrase {
  return {
    id: 'p1',
    phrase: '지금이 마지막 기회',
    normalized: '지금이마지막기회',
    category: 'UNSUPPORTED_CLAIM',
    note: null,
    ...over,
  } as RegisteredPhrase;
}

describe('rescanForPhrase', () => {
  it('그 표현이 든 글만 골라낸다', () => {
    const hits = rescanForPhrase(
      [
        target('a', '지금이 마지막 기회입니다.'),
        target('b', '실적을 근거로 목표가를 제시합니다.'),
      ],
      phrase(),
    );
    expect(hits.map((h) => h.reportId)).toEqual(['a']);
    expect(hits[0].quote).toContain('마지막 기회');
  });

  it('**코드 규칙이 잡은 것은 세지 않는다** — 이 표현의 공이 아니다', () => {
    // 이 글은 `원금 보장`(코드 규칙 BLOCK)에 걸리지만 새 표현과는 무관하다.
    // 섞이면 "새 표현 때문에 20건이 걸렸다"는 숫자가 거짓이 되고, 등록 여부 판단이 망가진다
    const hits = rescanForPhrase([target('a', '원금 보장 수준으로 안전합니다.')], phrase());
    expect(hits).toEqual([]);
  });

  it('**다른 학습 표현이 잡은 것도 세지 않는다** — 새 것만 나와야 한다', () => {
    // 사전에 여러 항목이 실려 들어와도 `learned:<id>` 로 갈린다
    const hits = rescanForPhrase(
      [target('a', '지금이 마지막 기회입니다.')],
      phrase({ id: 'p2', phrase: '전혀 다른 표현', normalized: '전혀다른표현' }),
    );
    expect(hits).toEqual([]);
  });

  it('한 글이 두 번 걸려도 한 줄이다 — 볼 것은 하나다', () => {
    const hits = rescanForPhrase(
      [target('a', '지금이 마지막 기회입니다. 정말 지금이 마지막 기회예요.')],
      phrase(),
    );
    expect(hits).toHaveLength(1);
  });

  it('글자를 벌려 써도 따라간다 — 사전은 규칙 엔진의 입력이라 정규화를 그대로 받는다', () => {
    const hits = rescanForPhrase([target('a', '지금이 마 지 막 기 회 입니다.')], phrase());
    expect(hits.map((h) => h.reportId)).toEqual(['a']);
  });

  it('대상이 없으면 빈 목록 — 0건은 "아무 일 없음"이고 화면은 아무것도 그리지 않는다', () => {
    expect(rescanForPhrase([], phrase())).toEqual([]);
  });
});
