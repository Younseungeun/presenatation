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

describe('IRIS → 사전/규칙 (졸업 강등 — 그림자 재생 증거)', () => {
  // 졸업 관찰 중인 표현. 관찰(watch hit)은 **기존 엔진이 잡은 출현만** 남고, 정탐/오탐은
  // 그 관찰이 붙은 문서의 사람 판정과의 사후 대조(그림자 값)다. 기본값 = 그림자 정탐이
  // 하한(3)에 닿고 오탐 0 — 표면형은 여러 종(엔진이 variation 을 흡수했다는 뜻)
  function graduatedPhrase(over: Partial<DetectionItemStats> = {}): DetectionItemStats {
    return {
      id: 'learned:g1',
      label: '수익 확실 세팅',
      layer: 'IRIS',
      matched: 4,
      truePos: T.ungraduateMinShadowTruePos,
      falsePos: 0,
      distinctSurfaces: 4,
      topSurfaceShare: 0.4,
      surfaceExamples: ['수익 확실 세팅', '수 익 확 실 세팅', '수익확실 셰팅'],
      studentMissCount: 0,
      ...over,
    };
  }

  it('그림자 정탐 ≥3 · 오탐 0 → 졸업 강등 추천 (코드가 이 variation 을 서술한다)', () => {
    expect(recommendMigration(graduatedPhrase())?.kind).toBe('UNGRADUATE');
  });

  it('**표면형 다양성은 트리거가 아니다** — 여러 꼴이어도 전부 엔진이 잡은 것이면 서술 가능', () => {
    // 굳음(≤3종·최빈 80%) 조건은 폐기됐다 (2026-08-31 창업자 지적: 굳음은 서술 가능성의
    // 하위 사례일 뿐이다). "원금 보장/원 금 보 장/원금보쟝"이 4종이어도 사전 항목 하나가
    // 전부 잡는다 — 관찰 기록의 존재 자체가 그 증거다
    expect(
      recommendMigration(graduatedPhrase({ distinctSurfaces: 9, topSurfaceShare: 0.15 }))?.kind,
    ).toBe('UNGRADUATE');
  });

  it('그림자 정탐이 하한 미만이면 추천 없음 — 실적 없이 서술을 주장할 수 없다', () => {
    expect(
      recommendMigration(graduatedPhrase({ truePos: T.ungraduateMinShadowTruePos - 1 })),
    ).toBeNull();
  });

  it('그림자 오탐이 하나라도 있으면 추천 없음 — 정상 글을 잡는 서술은 서술이 아니라 과매칭', () => {
    expect(recommendMigration(graduatedPhrase({ falsePos: 1 }))).toBeNull();
  });

  it('**미탐은 트리거가 아니다** — IRIS 의 실패는 재학습으로 고친다', () => {
    // 미탐이 아무리 쌓여도 그림자 정탐 실적이 없으면 추천 없음 — 처방은 재학습 + 응급 재활성화
    expect(recommendMigration(graduatedPhrase({ truePos: 0, studentMissCount: 5 }))).toBeNull();
  });

  it('미탐이 있어도 그림자 실적이 서면 졸업 강등 — 두 신호는 독립이다', () => {
    expect(recommendMigration(graduatedPhrase({ studentMissCount: 2 }))?.kind).toBe('UNGRADUATE');
  });

  it('사유가 범위를 정직하게 말한다 — 복귀 후보일 뿐, 신규 코드화 강등은 논의의 몫', () => {
    // 자동 추천은 졸업 강등의 좁은 지름길(옛 사전 항목의 복귀)만 다룬다 (2026-08-31
    // 창업자 지적) — 본선(코드화 설계)은 질문지 논의가 맡고, 사유가 그 경계를 말해야
    // 이 추천이 졸업 강등 전체의 메커니즘인 양 읽히지 않는다
    const reason = recommendMigration(graduatedPhrase())?.reason ?? '';
    expect(reason).toContain('표면형 4종');
    expect(reason).toContain('수익 확실 세팅');
    expect(reason).toContain(`정탐 ${T.ungraduateMinShadowTruePos}`);
    expect(reason).toContain('복귀');
    expect(reason).toContain('확정은 사람');
    expect(reason).toContain('논의의 몫');
    expect(reason).not.toContain('미탐');
  });
});
