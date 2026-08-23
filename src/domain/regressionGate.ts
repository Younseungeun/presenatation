import type { Finding, ScreeningInput } from './compliance';

// **회귀 게이트** (20차 X-5 · 21차 Y-5(b) 검토 확정) — 졸업 대비쌍을 학생이 통과해야
// 그 모델을 채택할 수 있다. 치명적 망각(졸업시킨 표현을 재학습이 지우는 것)의 유일한
// 방어선이다.
//
// **전 건 통과다 — 허용 오답률은 없다** (21차 판정: 그대로). 허용치를 두면 릴리스
// 압박 시 "적당히 핑계 대고 넘기는" 구멍이 된다. 정말 잘못 쓴 문항이라면
// 격리(quarantineRegressionCase — 2인 승인)로 빼고 100%를 맞추는 것이 정도다.
// 격리된 문항은 여기 들어오기 전에 걸러진다 (getRegressionCases 가 제외).

export interface RegressionGateCase {
  id: string;
  text: string;
  expectViolation: boolean;
  /** 위반 쪽만: 기대 유형 */
  category: string | null;
}

export interface RegressionGateFailure {
  id: string;
  text: string;
  expectViolation: boolean;
  expected: string | null;
  got: string[];
}

export interface RegressionGateResult {
  total: number;
  failures: RegressionGateFailure[];
  pass: boolean;
}

/** 회귀 문항 → 검수 입력. 카드는 중립값 — 재는 것은 문장이지 카드가 아니다 */
export function regressionInput(text: string): ScreeningInput {
  return {
    title: '',
    summary: '',
    content: text,
    assetClass: 'KR_EQUITY',
    assetName: '',
    direction: 'UP',
  };
}

/**
 * 게이트 판정 — 위반 문항은 기대 유형이 학생 소견에 있어야 하고, 정상 문항은
 * 학생이 아무 소견도 내면 안 된다. 호출 실패(null)는 **오답으로 센다**:
 * 게이트가 못 잰 모델을 통과시키면 게이트가 없는 것과 같다 (실패가 보이는 쪽으로).
 */
export async function runRegressionGate(
  cases: readonly RegressionGateCase[],
  screen: (input: ScreeningInput) => Promise<Finding[] | null>,
): Promise<RegressionGateResult> {
  const failures: RegressionGateFailure[] = [];
  for (const c of cases) {
    const findings = await screen(regressionInput(c.text)).catch(() => null);
    const got = findings === null ? ['(호출 실패)'] : [...new Set(findings.map((f) => f.category))];
    const ok =
      findings !== null &&
      (c.expectViolation
        ? c.category !== null && got.includes(c.category)
        : findings.length === 0);
    if (!ok) {
      failures.push({
        id: c.id,
        text: c.text,
        expectViolation: c.expectViolation,
        expected: c.category,
        got,
      });
    }
  }
  // **빈 시험지는 만점이 아니라 시험 불가다** (관리자 앱 4회차 §2 발견).
  // 예전 판정(failures.length === 0)은 문항 0개에서 통과였다 — 격리를 여러 번 반복하면
  // (승인·지문은 "한 번에 여러 개"만 막지 "여러 번"은 못 막는다) 게이트가 있는 채로
  // 아무것도 재지 않는 상태가 열려 있었다. "허용 오답률은 없다"의 구멍이 오답률이
  // 아니라 분모 쪽에 나 있던 것. 문항이 0이면 pass:false — 시험지를 채우기 전에는
  // 채택할 수 없다. (시드 17건이 fixture 라 실제로 0이 되려면 코드 변경까지 필요하지만,
  // 게이트의 뜻은 호출자가 무엇을 넘기든 성립해야 한다)
  return {
    total: cases.length,
    failures,
    pass: cases.length > 0 && failures.length === 0,
  };
}
