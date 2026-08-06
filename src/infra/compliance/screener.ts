import type { Finding, ScreeningInput } from '@/domain/compliance';
import type { CalibrationExample } from '@/domain/screeningAccuracy';

// 컴플라이언스 검수 공급자 추상화.
// 시세 공급자(MarketDataProvider)·본인인증(IdentityProvider)과 같은 패턴 —
// 개발·테스트는 스텁, 운영은 Claude 어댑터를 끼운다.

/**
 * 검수 1회의 토큰 사용량. 두 가지 목적으로 기록한다:
 *  ① 실제 검수 비용 측정 (모델 선택을 데이터로 결정하기 위해)
 *  ② 숙고량 신호 — 입력 대비 출력이 유난히 많으면 모델이 판단에 고심했다는 뜻이라,
 *     통과된 건이라도 운영자가 한 번 보는 게 낫다 (에스컬레이션 근거)
 */
export interface ScreeningUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ScreeningOutput {
  findings: Finding[];
  /** 사용량을 알 수 없는 구현(스텁 등)은 생략 */
  usage?: ScreeningUsage;
}

export interface ComplianceScreener {
  /** 검수 주체 식별자 — 감사 기록에 남는다 */
  readonly reviewerId: string;
  /**
   * 문맥 판단이 필요한 위반을 찾는다. 결정적 규칙(applyRules)이 이미 잡은 것은
   * 호출자가 병합하므로, 여기서는 규칙이 놓칠 만한 것에 집중한다.
   * 검수 자체가 불가능하면 예외를 던진다 (호출자가 UNAVAILABLE로 처리).
   *
   * calibration: 운영자가 오탐으로 판정한 과거 사례. 같은 오탐을 반복하지 않도록
   * 프롬프트에 함께 전달한다 (구현체가 활용하지 않아도 무방하다).
   */
  screen(input: ScreeningInput, calibration?: CalibrationExample[]): Promise<ScreeningOutput>;
}

/** 입력 대비 출력 비율 — 리포트 길이 차이를 정규화한 "숙고 지수" */
export function deliberationRatio(usage: ScreeningUsage): number | null {
  if (usage.inputTokens <= 0) return null;
  return usage.outputTokens / usage.inputTokens;
}

/** 개발·테스트용: AI 호출 없이 빈 결과 (결정적 규칙만 동작) */
export class NoopComplianceScreener implements ComplianceScreener {
  readonly reviewerId = 'noop';
  async screen(): Promise<ScreeningOutput> {
    return { findings: [] };
  }
}

/** 테스트용: 지정한 결과를 그대로 반환하거나 실패를 흉내낸다 */
export class FixtureComplianceScreener implements ComplianceScreener {
  readonly reviewerId = 'fixture';
  /** 마지막 호출에 전달된 보정 사례 — 되먹임 배선이 붙어 있는지 검증용 */
  lastCalibration: CalibrationExample[] | undefined;
  constructor(
    private readonly findings: Finding[] = [],
    private readonly failure?: Error,
    private readonly usage?: ScreeningUsage,
  ) {}
  async screen(
    _input: ScreeningInput,
    calibration?: CalibrationExample[],
  ): Promise<ScreeningOutput> {
    this.lastCalibration = calibration;
    if (this.failure) throw this.failure;
    return { findings: this.findings, usage: this.usage };
  }
}
