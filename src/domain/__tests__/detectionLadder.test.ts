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

describe('IRIS → 사전/규칙 (졸업 강등 — 적합성 트리거)', () => {
  // 졸업 관찰 중인 표현. 표면형은 **졸업 후 관찰**에서 잰 것이다(졸업 전 표면형은
  // 졸업의 근거라 반대 방향 증거로 못 쓴다). 기본값 = 굳은 형태로 3건(관찰 하한) 출현
  function graduatedPhrase(over: Partial<DetectionItemStats> = {}): DetectionItemStats {
    return {
      id: 'learned:g1',
      label: '수익 확실 세팅',
      layer: 'IRIS',
      matched: T.ungraduateMinObserved,
      truePos: 0,
      falsePos: 0,
      distinctSurfaces: 1,
      topSurfaceShare: 1,
      surfaceSampleCount: T.ungraduateMinObserved,
      studentMissCount: 0,
      ...over,
    };
  }

  it('졸업 후 출현이 굳은 형태로 반복되면 → 졸업 강등 추천 (코드가 완전히 잡음)', () => {
    expect(recommendMigration(graduatedPhrase())?.kind).toBe('UNGRADUATE');
  });

  it('형태가 다양하면 추천 없음 — 뜻으로 잡아야 하는 표현이라 IRIS 관할이 맞다', () => {
    expect(
      recommendMigration(graduatedPhrase({ distinctSurfaces: 8, topSurfaceShare: 0.3 })),
    ).toBeNull();
  });

  it('출현이 관찰 하한(3) 미만이면 추천 없음 — 1~2건으로는 "굳었다"를 말할 수 없다', () => {
    expect(
      recommendMigration(
        graduatedPhrase({
          matched: T.ungraduateMinObserved - 1,
          surfaceSampleCount: T.ungraduateMinObserved - 1,
        }),
      ),
    ).toBeNull();
  });

  it('표면형 미기록(0종)이면 추천 없음 — 분포를 모르면 판정하지 않는다', () => {
    expect(
      recommendMigration(graduatedPhrase({ distinctSurfaces: 0, topSurfaceShare: 0 })),
    ).toBeNull();
  });

  it('**미탐은 트리거가 아니다** — IRIS 의 실패는 재학습으로 고친다 (이동은 적합성으로만)', () => {
    // 미탐이 아무리 쌓여도 형태가 다양하면 추천 없음 — 처방은 재학습 + 응급 재활성화
    expect(
      recommendMigration(
        graduatedPhrase({ distinctSurfaces: 8, topSurfaceShare: 0.3, studentMissCount: 5 }),
      ),
    ).toBeNull();
  });

  it('미탐이 있어도 형태가 굳어 있으면 졸업 강등 — 두 신호는 독립이다', () => {
    expect(recommendMigration(graduatedPhrase({ studentMissCount: 2 }))?.kind).toBe('UNGRADUATE');
  });

  it('사유가 2단 구조를 말한다 — 형태 안정은 후보 신호, 서술 가능성 확정은 사람', () => {
    const reason = recommendMigration(graduatedPhrase())?.reason ?? '';
    expect(reason).toContain('굳은 형태');
    expect(reason).toContain('확정은 사람');
    expect(reason).not.toContain('미탐');
  });

  it('표면형 미기록 관찰은 하한의 분모에 못 낀다 — 기록 1건이 미기록 2건을 업고 못 넘는다', () => {
    // 전환기(컬럼 이전 기록 혼재): 관찰 3건이지만 분포를 잰 표본은 1건뿐 —
    // 1건짜리 분포는 최빈 100%가 자동 성립하므로, 하한은 잰 표본으로 세야 한다
    expect(
      recommendMigration(
        graduatedPhrase({ matched: 3, surfaceSampleCount: 1, distinctSurfaces: 1, topSurfaceShare: 1 }),
      ),
    ).toBeNull();
  });
});
