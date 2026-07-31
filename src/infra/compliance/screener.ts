import type { Finding, ScreeningInput } from '@/domain/compliance';

// 컴플라이언스 검수 공급자 추상화.
// 시세 공급자(MarketDataProvider)·본인인증(IdentityProvider)과 같은 패턴 —
// 개발·테스트는 스텁, 운영은 Claude 어댑터를 끼운다.

export interface ComplianceScreener {
  /** 검수 주체 식별자 — 감사 기록에 남는다 */
  readonly reviewerId: string;
  /**
   * 문맥 판단이 필요한 위반을 찾는다. 결정적 규칙(applyRules)이 이미 잡은 것은
   * 호출자가 병합하므로, 여기서는 규칙이 놓칠 만한 것에 집중한다.
   * 검수 자체가 불가능하면 예외를 던진다 (호출자가 UNAVAILABLE로 처리).
   */
  screen(input: ScreeningInput): Promise<Finding[]>;
}

/** 개발·테스트용: AI 호출 없이 빈 결과 (결정적 규칙만 동작) */
export class NoopComplianceScreener implements ComplianceScreener {
  readonly reviewerId = 'noop';
  async screen(): Promise<Finding[]> {
    return [];
  }
}

/** 테스트용: 지정한 결과를 그대로 반환하거나 실패를 흉내낸다 */
export class FixtureComplianceScreener implements ComplianceScreener {
  readonly reviewerId = 'fixture';
  constructor(
    private readonly findings: Finding[] = [],
    private readonly failure?: Error,
  ) {}
  async screen(): Promise<Finding[]> {
    if (this.failure) throw this.failure;
    return this.findings;
  }
}
