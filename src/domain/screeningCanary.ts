import type { RiskCategory, ScreeningInput } from './compliance';

// **규칙 검수가 지금 실제로 도는가** — 14차 R-1.
//
// ── 왜 필요한가 (2026-08-20 실제 사고) ────────────────────────────
// 표기 회피 방어를 붙이고 44건 코퍼스로 게시 차단율 28% → 92%를 측정했다. 그 숫자는
// **탐침 스크립트에서만** 참이었다 — 운영 경로가 문맥 없이 `applyRules(input)`를 부르고
// 있었고, 문맥이 없으면 그 층은 설계대로 침묵한다. 운영에서는 0%였다.
//
// 이 실패는 **고장 나지 않는다.** 예외도 경고도 없고 시험 820건이 전부 초록이며
// `ctx.knownNames ?? new Set()`은 완벽하게 정상인 코드다. 같은 모양을 이 저장소는
// 다섯 번 만났다(8차 학습셋=채점지 · 9차 사이드카 유실 · 12차 빈 카드 측정 ·
// 13차 전량 학습 · 이번 배선).
//
// 구조 시험(screeningWiring.test.ts)이 이 한 자리를 지키지만, 그것은 **소스의 모양**만
// 본다. 다음에 다른 방식으로 같은 실패가 나면 못 잡는다. 그래서 **결과를 직접 잰다** —
// 정답이 정해진 문장을 실제 파이프라인에 통과시키고 답이 맞는지 본다.
//
// ── 왜 층마다 한 건씩인가 ─────────────────────────────────────────
// 규칙 검수는 네 층이고 층마다 죽는 이유가 다르다. 한 건만 두면 ①층이 살아 있는 한
// 초록이라, 정작 이번에 죽은 ④층을 못 본다. **층 하나가 죽으면 정확히 한 건이 빨개진다.**
//
// ── 왜 정상 문항이 있는가 ─────────────────────────────────────────
// 카나리아가 "무엇이든 잡으면 통과"면 규칙이 미쳐서 전부 잡는 상태도 초록이다.
// 미탐과 오탐을 **함께** 본다.

export interface CanaryCase {
  id: string;
  /**
   * 이 문항이 지키는 층.
   *
   * 이름이 그대로 화면(띠지·실패 알림)에 나가므로 `정상`이 아니라 **`정상문항`**이다 —
   * 띠지는 `<층 이름> <상태>` 꼴이라 `정상 통과`가 되면 무엇을 재는 칸인지 사라진다.
   */
  layer: '원문' | '기호제거' | '깊은정규화' | '훼손신호' | '사전입력' | '정상문항';
  content: string;
  /** 규칙(code) 소견에 **반드시** 있어야 하는 유형. 빈 배열이면 소견이 하나도 없어야 한다 */
  expect: RiskCategory[];
  /** 이 문항이 죽었을 때 무엇을 잃는지 — 알림에 그대로 실린다 */
  meaning: string;
}

/**
 * @근거 설계 — 44건 적대적 코퍼스(training/holdout/evasion-13.json)에서 층마다 한 건씩
 *   골랐다. **표본이 아니라 배선 점검**이라 통계적 대표성은 필요 없고, 층 하나가 죽으면
 *   정확히 한 건이 빨개지는 것만 필요하다.
 *
 *   ④훼손신호 문항이 이번 사고를 잡는 자리다 — 종목 마스터가 문맥에 안 실리면
 *   그 층이 침묵하므로 이 한 건이 즉시 빨개진다.
 */
export const SCREENING_CANARY: CanaryCase[] = [
  {
    id: 'literal',
    layer: '원문',
    content: '이 종목은 원금을 보장해 드리겠습니다.',
    expect: ['PROFIT_GUARANTEE'],
    meaning: '정규식 규칙이 통째로 죽었습니다 (검수의 바닥이 빠진 상태)',
  },
  {
    id: 'spread',
    layer: '기호제거',
    content: '원.금.보.장 합니다',
    expect: ['PROFIT_GUARANTEE'],
    meaning: '글자를 벌린 회피가 전부 통과합니다',
  },
  {
    id: 'jamo',
    layer: '깊은정규화',
    content: 'ㅇ ㅝ ㄴ ㄱ ㅡ ㅁ ㅂ ㅗ ㅈ ㅏ ㅇ 선언',
    expect: ['PROFIT_GUARANTEE'],
    meaning: '낱자·유니코드로 바꿔 쓴 회피가 전부 통과합니다',
  },
  {
    id: 'mixed-script',
    layer: '훼손신호',
    content: '텔le그ram 으로 오세요',
    expect: ['SCREENING_EVASION'],
    // 2026-08-20에 실제로 이 자리가 조용히 꺼져 있었다
    meaning: '종목 마스터가 검수 문맥에 실리지 않아 표기 회피 탐지가 꺼졌습니다',
  },
  {
    // **사전 입력 배선** (20차 · 관리자 앱 Q6). 사전이 규칙 엔진의 입력이 되면서
    // "사전 쪽 배선이 조용히 끊긴" 상태가 새로 가능한 고장이 됐다 — 코드 패턴은 다
    // 살아 있는데 ctx.phrases 만 안 실리는 경우, 다른 문항은 전부 초록이다.
    // 이 문항은 **합성 표식**(운영자가 등록하는 게 아니라 카나리아가 매번 주입)이라
    // 코드 규칙 어디에도 안 걸리고, 오직 사전 경로로만 잡힌다.
    id: 'phrase-input',
    layer: '사전입력',
    content: '카나리아점검용문구 가 포함된 문장입니다',
    expect: ['UNSUPPORTED_CLAIM'],
    meaning: '운영자 사전이 검수 문맥에 실리지 않아 등록 표현이 전부 통과합니다',
  },
  {
    id: 'disclaimer',
    layer: '정상문항',
    content: '과거 수익률이 미래 수익을 보장하지 않습니다',
    expect: [],
    meaning: '표준 면책 문구가 막힙니다 — 정상 리포트 대부분이 이 문장을 담습니다',
  },
  {
    id: 'listed-name',
    layer: '정상문항',
    content: '삼성SDI의 하반기 실적을 분석했습니다',
    expect: [],
    meaning: '문자를 섞어 쓰는 정상 종목명이 회피로 지적됩니다',
  },
];

/** 카나리아 문항을 검수 입력으로 만든다 — 카드는 규칙이 조용한 중립값 */
export function canaryInput(c: CanaryCase): ScreeningInput {
  return {
    title: '',
    summary: '',
    content: c.content,
    assetClass: 'KR_EQUITY',
    assetName: '삼성전자',
    direction: 'UP',
    targetType: 'RETURN_PCT',
    magnitudePct: 12,
    horizonDays: 90,
    confidence: 5,
  };
}

export interface CanaryFailure {
  id: string;
  layer: CanaryCase['layer'];
  meaning: string;
  missing: RiskCategory[];
  unexpected: RiskCategory[];
}

/**
 * 규칙 소견을 기대와 견준다.
 *
 * **규칙(code) 소견만 본다.** 학생 모델은 확률적이라 카나리아를 흔들고, 학생에게는
 * 이미 자기 카나리아(가중치 지문 + 로짓 대조)가 있다. 여기서 재는 것은 **결정적 층**이다.
 */
export function checkCanary(c: CanaryCase, found: readonly RiskCategory[]): CanaryFailure | null {
  const got = new Set(found);
  const missing = c.expect.filter((e) => !got.has(e));
  // 정상 문항은 소견이 하나라도 있으면 실패. 위반 문항은 기대한 유형만 확인한다 —
  // 다른 유형이 함께 잡히는 것은 이 카나리아가 판단할 일이 아니다(오탐 측정은 코퍼스의 몫)
  const unexpected = c.expect.length === 0 ? [...got] : [];
  if (missing.length === 0 && unexpected.length === 0) return null;
  return { id: c.id, layer: c.layer, meaning: c.meaning, missing, unexpected };
}

/**
 * 사전 입력 배선용 합성 표현 (20차 · Q6).
 *
 * **운영 사전에 있는 표현을 쓰지 않는다** — 그러면 사전이 비어 있을 때(정상 상태)와
 * 배선이 끊겼을 때(고장)가 같은 빨간불이 된다. 카나리아 러너가 이 표식을 검수 문맥에
 * **직접 주입**하므로, 빨간불의 뜻이 "주입한 것이 안 돌았다 = 배선이 끊겼다" 하나로
 * 좁혀진다. 실제 리포트에 나올 수 없는 문자열이라 오탐도 못 만든다.
 */
export const CANARY_PHRASE = {
  id: 'canary-phrase',
  phrase: '카나리아점검용문구',
  normalized: '카나리아점검용문구',
  category: 'UNSUPPORTED_CLAIM',
  note: '카나리아 전용 — 운영 사전 항목이 아닙니다',
  phoneticEligible: false,
} as const;
