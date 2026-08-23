import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRules, type ScreeningInput } from '../compliance';
import { FINANCE_TERMS } from '../evasionNormalize';

// **전수 충돌 조사** (17차 — 검토가 "먼저 재야 할 것"으로 지목).
//
// 종목 마스터 전체와 정상 금융 용어를 **여섯 층 전부**에 통과시켜 소견이 하나라도
// 나오는지 본다. 새 층을 더하거나 임계값을 만질 때 이 시험이 먼저 빨개진다.
//
// ── 왜 이 시험이 필요한가 ─────────────────────────────────────────
// 이번 회차에만 층끼리 부딪힌 사례가 셋이었다:
//   · `올 인 퓨처테크 얼라이언스` → ②층 정규화가 `올인` 을 만들었다
//   · `루시드 다이어그노스틱스`   → 원문에 이미 `시드 다` 가 있었다
//   · `손실보장` 을 ⑤층에 넣었더니 `손실보상`(정상 용어)이 걸렸다
// 셋 다 **한 층 안에서는 옳은데 시스템이 틀린** 모양이다.
//
// ⚠ 이 시험은 **이름 단독**을 본다. 실제 문맥의 오탐률은 여기서 못 잰다 —
//   그건 DART 공시 3,000문장 대조군이 와야 답이 나온다 (17차 U-5).

const CARD = {
  assetClass: 'KR_EQUITY',
  direction: 'UP',
  targetType: 'RETURN_PCT',
  magnitudePct: 12,
  horizonDays: 90,
  confidence: 5,
} as const;

/** 종목 마스터 스냅숏 — DB 없이 CI에서 돌기 위해 파일로 둔다 */
function instrumentNames(): string[] {
  try {
    const raw = readFileSync(join(process.cwd(), 'training', 'holdout', 'instrument-names.json'), 'utf-8');
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

describe('전수 충돌 조사 — 정상 이름이 여섯 층 어디에도 안 걸린다', () => {
  const names = instrumentNames();
  const known = new Set(names.map((n) => n.toLowerCase()));

  it('스냅숏이 있어야 이 시험이 뜻을 갖는다', () => {
    // 스냅숏이 비면 이 시험은 아무것도 안 하면서 초록이다 — 조용한 무동작
    expect(names.length, 'npm run snapshot:instruments 로 만듭니다').toBeGreaterThan(1000);
  });

  it('상장 종목명 전체가 소견을 내지 않는다', () => {
    const hits: string[] = [];
    for (const name of names) {
      const f = applyRules(
        { title: '', summary: '', content: name, assetName: name, ...CARD } as ScreeningInput,
        { knownNames: known },
      );
      if (f.length > 0) hits.push(`${name} → ${f.map((x) => `${x.category}/${x.severity}`).join(',')}`);
    }
    expect(hits.slice(0, 20), `${hits.length}건 충돌`).toEqual([]);
    /* **넉넉한 문턱을 손으로 준다** (2026-08-24). 이 시험은 상장 종목명 수천 개를
       여섯 층에 통과시키므로 혼자 돌면 ~3초, 전체 실행 중에는 5~6.5초가 걸린다 —
       기본 문턱 5초 바로 위라 **전체를 돌릴 때만 간헐적으로 빨개졌다.**
       느려서 실패한 것을 사람은 "규칙이 깨졌다"로 읽는다(실제로 두 번 그렇게 봤다).
       재는 것은 속도가 아니라 충돌이므로 시간에는 여유를 준다 */
  }, 30_000);

  it('정상 금융 용어가 소견을 내지 않는다', () => {
    const hits: string[] = [];
    for (const term of FINANCE_TERMS) {
      const f = applyRules(
        { title: '', summary: '', content: term, assetName: '삼성전자', ...CARD } as ScreeningInput,
        { knownNames: known },
      );
      if (f.length > 0) hits.push(`${term} → ${f.map((x) => x.category).join(',')}`);
    }
    expect(hits).toEqual([]);
  });
});
