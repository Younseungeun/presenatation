import { describe, expect, it } from 'vitest';
import {
  assembleItemTeacherPack,
  classifyItemVerdict,
  ITEM_PACK_MAX_LINES,
  summarizeSurfaces,
  type ItemEvidenceLine,
} from '../itemTeacherPack';

// 검출 항목별 질문지 (2026-09-01) — "'인스타그램' 때문에 걸린 것들을 한자리에" 의 조립 계약.
// 값이 아니라 **구조**를 고정한다: 판정별 묶음 · 출현형 요약 · 상한 · 층에 맞는 논의 항목.

const d = (day: number) => new Date(Date.UTC(2026, 8, day));
const line = (over: Partial<ItemEvidenceLine>): ItemEvidenceLine => ({
  sentence: '자세한 내용은 인스타그램 DM 으로 문의 주세요',
  surface: '인스타그램',
  verdict: 'TP',
  createdAt: d(1),
  ...over,
});
const stats = { matched: 4, truePos: 3, falsePos: 1, ageDays: 12, distinctResearchers: 2, negationHits: 0, distinctSurfaces: 2, topSurfaceShare: 0.75 };

describe('사람 판정 4갈래 — 사다리 집계와 같은 잣대', () => {
  it('반려·철회 = 정탐, 승인+지적 타당 = 경미, 승인+지적 부당(기본) = 오탐, 나머지 = 판정 전', () => {
    expect(classifyItemVerdict('REJECTED', null)).toBe('TP');
    expect(classifyItemVerdict('TAKEDOWN', null)).toBe('TP');
    expect(classifyItemVerdict('APPROVED', true)).toBe('MINOR');
    expect(classifyItemVerdict('APPROVED', false)).toBe('FP');
    expect(classifyItemVerdict('APPROVED', null)).toBe('FP');
    expect(classifyItemVerdict(null, null)).toBe('PENDING');
    expect(classifyItemVerdict('KEPT', null)).toBe('PENDING');
  });
});

describe('출현형 요약', () => {
  it('빈도순, 출현형 없는 줄은 세지 않는다', () => {
    const s = summarizeSurfaces([
      line({ surface: '인스타' }),
      line({ surface: '인스타그램' }),
      line({ surface: '인스타' }),
      line({ surface: null }),
    ]);
    expect(s).toEqual([
      { surface: '인스타', n: 2 },
      { surface: '인스타그램', n: 1 },
    ]);
  });
});

describe('질문지 조립', () => {
  it('걸린 문장을 판정별로 묶고, 출현형·성적·추천을 싣는다', () => {
    const { text, count, title } = assembleItemTeacherPack({
      itemId: 'learned:p1',
      label: '인스타그램',
      layer: 'PHRASE',
      category: 'SOLICIT_CONTACT',
      stats: { ...stats, recommendation: 'PROMOTE_RULE — 5조건 통과' },
      evidence: [
        line({ verdict: 'TP', createdAt: d(3) }),
        line({ verdict: 'FP', surface: '인스타', sentence: '인스타그램 광고 지출이 늘었다', createdAt: d(2) }),
        line({ verdict: 'MINOR', createdAt: d(1) }),
        line({ verdict: 'PENDING', negation: 'WEAK', createdAt: d(4) }),
      ],
    });
    expect(title).toContain('인스타그램');
    expect(count).toBe(4);
    // 판정별 묶음 머리 — 순서: 정탐 → 오탐 → 경미 → 판정 전
    const iTP = text.indexOf('### 정탐');
    const iFP = text.indexOf('### 오탐');
    const iMinor = text.indexOf('### 경미');
    const iPending = text.indexOf('### 판정 전');
    expect(iTP).toBeGreaterThan(-1);
    expect(iFP).toBeGreaterThan(iTP);
    expect(iMinor).toBeGreaterThan(iFP);
    expect(iPending).toBeGreaterThan(iMinor);
    // 출현형 요약 + 부정 표식 + 성적 + 추천
    expect(text).toContain('“인스타그램” × 3');
    expect(text).toContain('“인스타” × 1');
    expect(text).toContain('부정 WEAK');
    expect(text).toContain('걸림 4 · 정탐 3 · 오탐 1');
    expect(text).toContain('PROMOTE_RULE — 5조건 통과');
    // 판정을 요청하는 자료가 아니라는 고지가 맨 앞에
    expect(text.startsWith('> **판정을 요청하는 자료가 아닙니다.**')).toBe(true);
  });

  it('논의 항목은 층에 따라 다르다 — 학습표현은 WARN 승격·ARGOS 졸업, 규칙은 BLOCK·ARGOS 위임', () => {
    const phrase = assembleItemTeacherPack({
      itemId: 'learned:p1', label: 'x', layer: 'PHRASE', stats, evidence: [line({})],
    }).text;
    expect(phrase).toContain('규칙 WARN 으로 올릴 수 있나');
    expect(phrase).toContain('ARGOS 졸업');
    expect(phrase).not.toContain('BLOCK 으로 올릴 수 있나');

    const rule = assembleItemTeacherPack({
      itemId: 'PROFIT_GUARANTEE', label: 'PROFIT_GUARANTEE', layer: 'RULE_WARN',
      reason: '수익을 보장하는 표현', stats, evidence: [line({ surface: null, layer: 'L2_SEPARATOR' })],
    }).text;
    expect(rule).toContain('BLOCK 으로 올릴 수 있나');
    expect(rule).toContain('ARGOS 위임(졸업)');
    expect(rule).toContain('규칙 사유문: 수익을 보장하는 표현');
    expect(rule).toContain('[L2_SEPARATOR]');
    expect(rule).not.toContain('규칙 WARN 으로 올릴 수 있나');
  });

  it('ARGOS 유형별 모음은 졸업 강등 본선 논의를 묻고, 검출/미탐 수를 싣는다', () => {
    const text = assembleItemTeacherPack({
      itemId: 'argos:SOLICIT_CONTACT',
      label: '외부 채널 유도',
      layer: 'ARGOS_CATEGORY',
      category: 'SOLICIT_CONTACT',
      stats: { matched: 3, truePos: 3, falsePos: 0, argosDetected: 2, argosMissed: 1 },
      evidence: [
        line({ surface: null, layer: 'ARGOS 검출', sentence: '자세한 건 디엠 주시면 알려드려요' }),
        line({ surface: null, layer: 'ARGOS 미탐', sentence: '노란 앱으로 오세요' }),
      ],
    }).text;
    expect(text).toContain('ARGOS 가 잡은 확정 건 2 · ARGOS 가 놓친 확정 건(통과 후 철회) 1');
    expect(text).toContain('졸업 강등 본선 — 코드로 내릴 수 있나');
    expect(text).toContain('[ARGOS 미탐] “노란 앱으로 오세요”');
    // 항목 질문지의 사다리 문항은 여기 없다 — 이건 항목이 아니라 유형 모음이다
    expect(text).not.toContain('규칙 WARN 으로 올릴 수 있나');
    expect(text).not.toContain('BLOCK 으로 올릴 수 있나');
  });

  it('같은 문장·같은 판정은 한 줄로 접는다 (재검수 반복 스냅샷) — 판정이 다르면 따로 남는다', () => {
    const { text, count } = assembleItemTeacherPack({
      itemId: 'RUMOR_SOURCE', label: 'RUMOR_SOURCE', layer: 'RULE_WARN', stats,
      evidence: [
        line({ surface: null, sentence: '소문에 의하면 좋다', verdict: 'PENDING', createdAt: d(1) }),
        line({ surface: null, sentence: '소문에 의하면 좋다', verdict: 'PENDING', createdAt: d(2) }),
        line({ surface: null, sentence: '소문에 의하면 좋다', verdict: 'PENDING', createdAt: d(3) }),
        line({ surface: null, sentence: '소문에 의하면 좋다', verdict: 'TP', createdAt: d(4) }),
      ],
    });
    expect(count).toBe(2);
    expect(text).toContain('### 정탐 — 걸렸고 사람이 반려·철회로 확정 — 1건');
    expect(text).toContain('### 판정 전 — 아직 사람 결론이 없음 — 1건');
  });

  it('상한을 넘으면 최신순으로 자르고 그 사실을 적는다', () => {
    const many = Array.from({ length: ITEM_PACK_MAX_LINES + 5 }, (_, i) =>
      line({ createdAt: new Date(Date.UTC(2026, 0, 1 + i)), sentence: `문장 ${i}` }),
    );
    const { text, count } = assembleItemTeacherPack({
      itemId: 'learned:p1', label: 'x', layer: 'PHRASE', stats, evidence: many,
    });
    expect(count).toBe(ITEM_PACK_MAX_LINES);
    expect(text).toContain(`최근 ${ITEM_PACK_MAX_LINES}건만`);
    // 가장 오래된 것(문장 0)은 잘리고 가장 최신(문장 64)은 남는다
    expect(text).toContain(`문장 ${ITEM_PACK_MAX_LINES + 4}`);
    expect(text).not.toContain('“문장 0”');
  });

  it('걸린 문장이 없어도 깨지지 않고 그 사실을 말한다', () => {
    const { text, count } = assembleItemTeacherPack({
      itemId: 'learned:p1', label: 'x', layer: 'PHRASE', stats: { matched: 0, truePos: 0, falsePos: 0 }, evidence: [],
    });
    expect(count).toBe(0);
    expect(text).toContain('아직 걸린 문장이 없습니다');
    expect(text).toContain('출현형 스냅샷이 없습니다');
  });
});
