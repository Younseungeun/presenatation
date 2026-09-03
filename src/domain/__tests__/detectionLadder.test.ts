import { describe, expect, it } from 'vitest';
import {
  LADDER_THRESHOLDS as T,
  LADDER_THRESHOLDS_COLDSTART,
  recommendMigration,
  type DetectionItemStats,
} from '../detectionLadder';

// 승격/강등 사다리 추천 로직 (2026-08-28, 회신 25호 답장 관문 설계).

function phrase(over: Partial<DetectionItemStats> = {}): DetectionItemStats {
  // 5조건을 통과하고 형태가 안정적인 기본값 (규칙감). 동반 검출은 미실증(0/0)이 기본 —
  // 졸업은 실증이 있어야만 뜬다
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
    studentCoDetected: 0,
    studentMissed: 0,
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

  // 12차 검토 C-5 (2026-09-01) — 옛 조건은 "오탐 0"뿐이라 전부 경미(정탐 0)인 표현도 승격 후보였다
  it('경미 비율이 상한을 넘으면 승격 후보가 아니다 — 지적만 맞고 게시는 되는 표현을 코드로 굳히지 않는다', () => {
    // 정탐 20 · 경미 10 → 경미 33% > 20%
    expect(recommendMigration(phrase({ truePos: 20, minorPos: 10 }))).toBeNull();
    // 정탐 28 · 경미 2 → 6.7% ≤ 20% → 통과
    expect(recommendMigration(phrase({ truePos: 28, minorPos: 2 }))?.kind).toBe('PROMOTE_RULE');
    // 전부 경미(정탐 0) — 옛 구멍의 정확한 모양
    expect(recommendMigration(phrase({ truePos: 0, minorPos: T.phraseMinMatched }))).toBeNull();
  });

  // 12차 검토 C-1 반채택 — 동반 1/1 은 우연이라 최소 건수를 요구한다
  it('IRIS 동반 검출이 최소 건수 미만이면 졸업 추천이 뜨지 않는다 (미동반 0 이어도)', () => {
    expect(
      recommendMigration(
        phrase({ distinctSurfaces: 8, topSurfaceShare: 0.3, studentCoDetected: T.graduateMinCoDetected - 1, studentMissed: 0 }),
      ),
    ).toBeNull();
    expect(
      recommendMigration(
        phrase({ distinctSurfaces: 8, topSurfaceShare: 0.3, studentCoDetected: T.graduateMinCoDetected, studentMissed: 0 }),
      )?.kind,
    ).toBe('GRADUATE_IRIS');
  });

  // 12차 검토 C-7 — 콜드스타트 프로필: 절대 건수 대신 꼬리 연속 정탐. 나머지 조건은 그대로
  it('콜드스타트 프로필은 걸림 30 대신 연속 정탐 10 을 본다 — 표준 프로필은 같은 표본을 거절', () => {
    const few = phrase({ matched: 12, truePos: 12, tailTruePosStreak: 10 });
    expect(recommendMigration(few)).toBeNull(); // 표준: 걸림 30 미달
    expect(recommendMigration(few, LADDER_THRESHOLDS_COLDSTART)?.kind).toBe('PROMOTE_RULE');
    // 연속이 끊겼으면(경미로 리셋) 콜드스타트도 거절 — 요구를 낮추는 것이 아니다
    expect(recommendMigration(phrase({ matched: 12, truePos: 11, minorPos: 1, tailTruePosStreak: 3 }), LADDER_THRESHOLDS_COLDSTART)).toBeNull();
    // 리서처 수 하한은 그대로 — 한 사람 10장으로 승격되면 안 된다
    expect(
      recommendMigration(phrase({ matched: 12, truePos: 12, tailTruePosStreak: 10, distinctResearchers: 1 }), LADDER_THRESHOLDS_COLDSTART),
    ).toBeNull();
  });

  // 12차 검토 C-2 — 규칙도 출현형이 남으니 형태 안정을 BLOCK 자격에 건다. 표본 미달은 "모름"
  it('규칙 BLOCK 자격: 출현형 표본이 충분한데 형태가 흔들리면 거절, 표본이 모자라면 종전대로', () => {
    const base = rule({ matched: T.blockMinMatched, truePos: T.blockMinMatched, ageDays: T.blockMinAgeDays });
    // 표본 충분 + 흔들림(8종·최빈 30%) → BLOCK 감 아님
    expect(
      recommendMigration({ ...base, surfaceSamples: T.blockMinSurfaceSamples, distinctSurfaces: 8, topSurfaceShare: 0.3 }),
    ).toBeNull();
    // 표본 충분 + 굳음 → 자격
    expect(
      recommendMigration({ ...base, surfaceSamples: T.blockMinSurfaceSamples, distinctSurfaces: 2, topSurfaceShare: 0.9 })?.kind,
    ).toBe('PROMOTE_BLOCK');
    // 표본 미달(도입 전 기록) → 형태를 모르니 종전대로 자격
    expect(
      recommendMigration({ ...base, surfaceSamples: T.blockMinSurfaceSamples - 1, distinctSurfaces: 8, topSurfaceShare: 0.3 })?.kind,
    ).toBe('PROMOTE_BLOCK');
  });

  it('5조건 + 형태 다양 + IRIS 동반 검출 실증(미동반 0) → 졸업 (중복이라 내려도 안전)', () => {
    // 졸업 판별자는 "형태 다양"이 아니라 동반 검출 실증이다 (2026-08-31 교체)
    expect(
      recommendMigration(
        phrase({ distinctSurfaces: 8, topSurfaceShare: 0.3, studentCoDetected: 30, studentMissed: 0 }),
      )?.kind,
    ).toBe('GRADUATE_IRIS');
  });

  it('**형태 다양만으로는 졸업 안 됨** — 다양한 표면형은 전부 사전이 잡은 것이라 오히려 잘 작동한다는 증거', () => {
    // 옛 판별자("형태 다양 → 뜻으로")의 오류: 사전이 가장 잘 작동하는 순간에 사전을 껐다.
    // 동반 실증이 없으면(0/0) 모르는 것이므로 내리지 않는다
    expect(
      recommendMigration(phrase({ distinctSurfaces: 8, topSurfaceShare: 0.3 })),
    ).toBeNull();
  });

  it('IRIS 미동반이 하나라도 있으면 졸업 안 됨 — 사전이 하중을 지고 있다', () => {
    expect(
      recommendMigration(
        phrase({ distinctSurfaces: 8, topSurfaceShare: 0.3, studentCoDetected: 29, studentMissed: 1 }),
      ),
    ).toBeNull();
  });

  it('형태 안정 + 동반 검출이어도 규칙 승격이 우선 — 규칙(→BLOCK)은 즉시 거절로 가는 유일한 길', () => {
    expect(
      recommendMigration(phrase({ studentCoDetected: 30, studentMissed: 0 }))?.kind,
    ).toBe('PROMOTE_RULE');
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

describe('IRIS → 사전 (복귀 — 졸업 강등의 자동 지름길)', () => {
  // 졸업 관찰 중인 표현. 복귀의 실증은 두 사실의 교집합이다: 옛 항목이 잡았고(그림자
  // 정탐) IRIS 는 놓쳤다(미탐). 기본값 = 미탐-정탐이 하한(2)에 닿고 그림자 오탐 0
  function graduatedPhrase(over: Partial<DetectionItemStats> = {}): DetectionItemStats {
    return {
      id: 'learned:g1',
      label: '수익 확실 세팅',
      layer: 'IRIS',
      matched: 4,
      truePos: 3,
      falsePos: 0,
      missTruePos: T.ungraduateMinMissTruePos,
      distinctSurfaces: 4,
      topSurfaceShare: 0.4,
      surfaceExamples: ['수익 확실 세팅', '수 익 확 실 세팅', '수익확실 셰팅'],
      studentMissCount: 2,
      ...over,
    };
  }

  it('IRIS 가 놓친 확정 위반 ≥2 를 옛 항목이 잡음 · 그림자 오탐 0 → 복귀 추천', () => {
    expect(recommendMigration(graduatedPhrase())?.kind).toBe('UNGRADUATE');
  });

  it('**IRIS 도 다 잡고 있으면(미탐-정탐 0) 추천 없음** — 중복이라 되살릴 이유가 없다', () => {
    // 옛 항목이 아무리 잘 잡아도(정탐 3) IRIS 가 같은 건들을 전부 잡았다면 복귀는
    // 보호를 더하지 않는다 — 그건 졸업이 옳았다는 증거다 (2026-08-31 창업자 지적:
    // 복귀 = "규칙으로는 잘 잡는데 IRIS 로 못 잡는 경우")
    expect(
      recommendMigration(graduatedPhrase({ missTruePos: 0, studentMissCount: 0 })),
    ).toBeNull();
  });

  it('미탐-정탐 1건은 추천 없음 — 그 판정·신고 하나가 오판일 수 있다 (X-5 원칙)', () => {
    expect(
      recommendMigration(graduatedPhrase({ missTruePos: T.ungraduateMinMissTruePos - 1 })),
    ).toBeNull();
  });

  it('그림자 오탐이 하나라도 있으면 추천 없음 — 되살리면 정상 글을 잡는다', () => {
    expect(recommendMigration(graduatedPhrase({ falsePos: 1 }))).toBeNull();
  });

  it('판정 없는 미탐만 쌓이면 추천 없음 — 확정 위반의 미탐만 구멍의 실증이다', () => {
    // 미탐 총수(studentMissCount)가 아니라 사람이 위반으로 확정한 부분집합(missTruePos)만
    // 트리거다. 미탐 자체의 처방은 재학습 + 응급 재활성화(X-5)로 종전과 같다
    expect(
      recommendMigration(graduatedPhrase({ missTruePos: 0, studentMissCount: 5 })),
    ).toBeNull();
  });

  it('사유가 구멍의 실증과 범위를 말한다 — IRIS 미탐 + 옛 항목이 잡음, 본선은 논의의 몫', () => {
    const reason = recommendMigration(graduatedPhrase())?.reason ?? '';
    expect(reason).toContain('IRIS 가 놓친 확정 위반');
    expect(reason).toContain(`${T.ungraduateMinMissTruePos}건`);
    expect(reason).toContain('수익 확실 세팅');
    expect(reason).toContain('복귀');
    expect(reason).toContain('확정은 사람');
    expect(reason).toContain('논의의 몫');
  });
});
