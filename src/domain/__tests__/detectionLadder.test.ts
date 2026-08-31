import { describe, expect, it } from 'vitest';
import {
  LADDER_THRESHOLDS as T,
  recommendMigration,
  type DetectionItemStats,
} from '../detectionLadder';

// 승격/강등 사다리 추천 로직 (2026-08-28, 회신 25호 답장 관문 설계).

function phrase(over: Partial<DetectionItemStats> = {}): DetectionItemStats {
  // 5조건을 통과하고 형태가 안정적인 기본값 (규칙감)
  return {
    id: 'learned:p1',
    label: '오픈채팅방에서 안내',
    layer: 'PHRASE',
    matched: T.phraseMinMatched,
    truePos: T.phraseMinMatched,
    falsePos: 0,
    ageDays: T.phraseMinAgeDays,
    distinctResearchers: T.phraseMinResearchers,
    negationHits: 0,
    distinctSurfaces: 2,
    topSurfaceShare: 0.9,
    ...over,
  };
}
function rule(over: Partial<DetectionItemStats> = {}): DetectionItemStats {
  return { id: 'PROFIT_PROMISE', label: 'PROFIT_PROMISE', layer: 'RULE_WARN', matched: 0, truePos: 0, falsePos: 0, ...over };
}

describe('학습표현 → 규칙 WARN / 졸업', () => {
  it('5조건 통과 + 형태 안정 → 규칙 WARN 승격', () => {
    expect(recommendMigration(phrase())?.kind).toBe('PROMOTE_RULE');
  });

  it('5조건 통과 + 형태 다양 → IRIS 졸업 (뜻으로 잡아야)', () => {
    expect(recommendMigration(phrase({ distinctSurfaces: 8, topSurfaceShare: 0.3 }))?.kind).toBe(
      'GRADUATE_IRIS',
    );
  });

  it('오탐이 하나라도 있으면 5조건 미달 → 추천 없음', () => {
    expect(recommendMigration(phrase({ falsePos: 1 }))).toBeNull();
  });

  it('부정 문맥에서 걸린 적이 있으면 → 추천 없음 (5조건: 부정 0)', () => {
    expect(recommendMigration(phrase({ negationHits: 1 }))).toBeNull();
  });

  it('리서처 수 미달 → 추천 없음', () => {
    expect(recommendMigration(phrase({ distinctResearchers: T.phraseMinResearchers - 1 }))).toBeNull();
  });

  it('표본·경과 미달 → 추천 없음', () => {
    expect(recommendMigration(phrase({ matched: T.phraseMinMatched - 1 }))).toBeNull();
    expect(recommendMigration(phrase({ ageDays: T.phraseMinAgeDays - 1 }))).toBeNull();
  });
});

describe('규칙 WARN → BLOCK / IRIS 위임(졸업)', () => {
  it('오탐 0 + 관찰(100건·90일) 충족 → BLOCK 승격 자격', () => {
    expect(
      recommendMigration(rule({ matched: T.blockMinMatched, truePos: T.blockMinMatched, ageDays: T.blockMinAgeDays }))
        ?.kind,
    ).toBe('PROMOTE_BLOCK');
  });

  it('오탐 0인데 관찰 미달 → 추천 없음 (아직 자격 아님)', () => {
    expect(
      recommendMigration(rule({ matched: T.blockMinMatched - 1, ageDays: T.blockMinAgeDays })),
    ).toBeNull();
  });

  it('오탐 > 0 + 표본 충분 → IRIS 위임 (문맥 못 가름 = 졸업 계열, 하강이 아니다)', () => {
    expect(
      recommendMigration(rule({ matched: T.delegateMinMatched, truePos: T.delegateMinMatched - 3, falsePos: 3 }))?.kind,
    ).toBe('DELEGATE_IRIS');
  });

  it('오탐 > 0인데 표본 하한 미달 → 추천 없음 (위임 논의도 이르다)', () => {
    expect(recommendMigration(rule({ matched: T.delegateMinMatched - 1, falsePos: 1 }))).toBeNull();
  });

  it('이미 BLOCK 규칙은 더 올릴 곳이 없다 → 추천 없음', () => {
    expect(recommendMigration(rule({ layer: 'RULE_BLOCK', matched: 500, ageDays: 200 }))).toBeNull();
  });
});

describe('IRIS → 사전/규칙 (졸업 강등)', () => {
  // 졸업 관찰 중인 표현 — 관찰 창에서 나타났고 IRIS 가 놓친 횟수가 studentMissCount
  function graduatedPhrase(over: Partial<DetectionItemStats> = {}): DetectionItemStats {
    return {
      id: 'learned:g1',
      label: '수익 확실 세팅',
      layer: 'IRIS',
      matched: 3,
      truePos: 0,
      falsePos: 0,
      distinctSurfaces: 2,
      topSurfaceShare: 0.9,
      studentMissCount: T.ungraduateMinMisses,
      ...over,
    };
  }

  it('관찰 미탐이 문턱(2)에 닿으면 → 졸업 강등 추천', () => {
    expect(recommendMigration(graduatedPhrase())?.kind).toBe('UNGRADUATE');
  });

  it('미탐 1건은 추천 없음 — 신고·판정 하나가 오판일 수 있다 (X-5 원칙)', () => {
    expect(
      recommendMigration(graduatedPhrase({ studentMissCount: T.ungraduateMinMisses - 1 })),
    ).toBeNull();
  });

  it('형태 안정 → 사유가 코드 규칙 이식을 가리킨다 (올라갈 때와 같은 판별자)', () => {
    expect(recommendMigration(graduatedPhrase())?.reason).toContain('코드 규칙 이식');
  });

  it('형태 다양 → 사유가 재활성화(사전 복귀)를 가리킨다', () => {
    expect(
      recommendMigration(graduatedPhrase({ distinctSurfaces: 8, topSurfaceShare: 0.3 }))?.reason,
    ).toContain('재활성화');
  });

  it('IRIS 가 잘 잡고 있으면(미탐 0) → 추천 없음', () => {
    expect(recommendMigration(graduatedPhrase({ studentMissCount: 0 }))).toBeNull();
  });
});
