import { describe, expect, it } from 'vitest';
import { parseTeacherAnswer, teacherPackId } from '../teacherAnswer';

// 교사 답 파싱 — **못 읽으면 null**. 지어낸 라벨은 그대로 학습 자료가 된다.

const ID = teacherPackId('abc123');

describe('정상 답', () => {
  it('위반이 있으면 유형을 읽고 지적 타당성은 묻지 않는다', () => {
    const { answer } = parseTeacherAnswer(`{"id":"${ID}","labels":["PROFIT_GUARANTEE"]}`, ID);
    expect(answer).toEqual({ labels: ['PROFIT_GUARANTEE'], findingsValid: null, note: '' });
  });

  it('위반이 없으면 `지적:` 한 줄로 오탐과 경미를 가른다', () => {
    const over = parseTeacherAnswer(`{"id":"${ID}","labels":[]}\n지적: 과함`, ID).answer;
    const fine = parseTeacherAnswer(`{"id":"${ID}","labels":[]}\n지적: 타당`, ID).answer;
    expect(over?.findingsValid).toBe(false); // 과함 = 오탐 → 규칙을 고쳐야 한다
    expect(fine?.findingsValid).toBe(true); // 타당 = 경미 → 심각도를 고쳐야 한다
  });

  it('```로 감싸고 설명을 붙여도 읽는다 — 대화창이 실제로 그렇게 준다', () => {
    const text = [
      '판정 결과입니다.',
      '```json',
      `{"id":"${ID}","labels":["SOLICIT_CONTACT"]}`,
      '```',
      '외부 채널로 유도하는 문장이 본문 끝에 있습니다.',
    ].join('\n');
    const { answer } = parseTeacherAnswer(text, ID);
    expect(answer?.labels).toEqual(['SOLICIT_CONTACT']);
    expect(answer?.note).toContain('외부 채널');
  });

  it('같은 유형이 두 번 와도 한 번만 센다', () => {
    const { answer } = parseTeacherAnswer(
      `{"id":"${ID}","labels":["RUMOR","RUMOR"]}`,
      ID,
    );
    expect(answer?.labels).toEqual(['RUMOR']);
  });
});

describe('거절해야 하는 답', () => {
  it('JSON 줄이 없으면 못 읽는다', () => {
    expect(parseTeacherAnswer('위반 없어 보입니다', ID)).toEqual({
      answer: null,
      problem: 'NO_JSON',
    });
  });

  it('**앞 건의 답을 복사하면 거절한다** — 한 창에서 연속으로 물을 때 실제로 일어난다', () => {
    const other = teacherPackId('zzz999');
    expect(parseTeacherAnswer(`{"id":"${other}","labels":["RUMOR"]}`, ID).problem).toBe(
      'ID_MISMATCH',
    );
  });

  it('모르는 유형이 섞이면 **통째로** 거절한다 — 조용히 버리면 위반이 사라진다', () => {
    expect(
      parseTeacherAnswer(`{"id":"${ID}","labels":["PROFIT_GUARANTEE","MISSING_DISCLOSURE"]}`, ID)
        .problem,
    ).toBe('BAD_LABELS');
  });

  it('위반 없음인데 `지적:` 줄이 없으면 거절한다 — 오탐과 경미를 못 가른다', () => {
    expect(parseTeacherAnswer(`{"id":"${ID}","labels":[]}`, ID).problem).toBe(
      'MISSING_VALIDITY',
    );
  });

  // **부분 일치로 읽으면 정반대로 뒤집힌다** — `타당하지 않음`이 `타당`을 품고 있다.
  // 처음 구현이 포함 검사였고 이 시험이 그걸 잡았다. 그 라벨은 학습에 그대로 들어간다
  it('`타당`·`과함` 외의 서술은 읽지 않는다 — 뒤집히느니 사람이 고르는 편이 낫다', () => {
    for (const line of [
      '지적: 타당하지 않음',
      '지적: 타당하기도 과하기도',
      '지적: 과하다고 보기는 어렵습니다',
      '지적: 글쎄요',
    ]) {
      expect(
        parseTeacherAnswer(`{"id":"${ID}","labels":[]}\n${line}`, ID).problem,
        line,
      ).toBe('MISSING_VALIDITY');
    }
  });

  it('문장 끝 마침표는 봐준다 — 형식은 지켰는데 습관으로 찍은 점이다', () => {
    expect(
      parseTeacherAnswer(`{"id":"${ID}","labels":[]}\n지적: 과함.`, ID).answer?.findingsValid,
    ).toBe(false);
  });

  it('JSON 이 깨졌으면 지어내지 않는다', () => {
    expect(parseTeacherAnswer(`{"id":"${ID}", "labels":[`, ID).answer).toBeNull();
  });
});
