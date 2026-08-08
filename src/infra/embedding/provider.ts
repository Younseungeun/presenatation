// 임베딩 공급자 추상화.
//
// 시세(MarketDataProvider)·본인인증(IdentityProvider)·AI 검수(ComplianceScreener)와 같은 패턴:
// 포트를 먼저 두고 어댑터를 갈아끼운다. 여기서는 "문장 → 벡터" 변환만 책임진다.
//
// 왜 필요한가: 결정적 규칙과 학습 표현은 **글자가 같아야** 걸린다. 평가셋 기준으로
// 직설 표현은 91.7% 잡지만 같은 뜻을 다른 말로 쓴 문장(패러프레이즈)은 0%다.
// 임베딩은 문장을 의미 공간의 벡터로 바꿔 "다르게 썼지만 같은 뜻"을 잡는다.
//
// 운영 계획(CLAUDE.md 검수 로드맵 1단계): ONNX 소형 다국어 임베딩 모델을 서버와
// 브라우저 양쪽에서 돌린다. 브라우저는 예방(작성 중 경고), 서버는 집행(게시 판정) —
// 클라이언트 JS는 조작 가능하므로 브라우저 판단은 게이트가 될 수 없다.

export interface EmbeddingProvider {
  /**
   * 모델 식별자 (예: 'onnx:multilingual-e5-small@int8').
   * 저장된 벡터가 어느 모델에서 나왔는지 남겨야 한다 — 모델이 바뀌면 기존 벡터는
   * 좌표계가 달라 비교 자체가 무의미해지므로 전부 다시 계산해야 하기 때문.
   */
  readonly id: string;
  readonly dimensions: number;
  /** 여러 문장을 한 번에 — 문장 단위 호출은 모델 초기화 비용이 매번 든다 */
  embed(texts: string[]): Promise<Float32Array[]>;
}

/**
 * 테스트용 공급자: 문장 → 벡터 대응을 호출자가 직접 지정한다.
 *
 * 가짜 모델로 의미 유사도를 흉내 내지 않는다 — 그건 검증이 아니라 자기 위안이다.
 * 대신 "어떤 쌍이 유사한가"를 테스트가 통제해서 **인덱스·임계값·소견 생성 로직**만
 * 정확히 검증한다. 의미 성능은 실제 모델을 꽂고 `npm run eval:screening`으로 잰다.
 */
export class FixtureEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;
  private readonly vectors: Map<string, number[]>;

  /** id를 바꿀 수 있어야 "모델 교체" 상황을 테스트할 수 있다 */
  constructor(
    vectors: Record<string, number[]>,
    readonly id = 'fixture',
  ) {
    const entries = Object.entries(vectors);
    this.dimensions = entries[0]?.[1].length ?? 0;
    this.vectors = new Map(entries);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = this.vectors.get(t.trim());
      if (!v) throw new Error(`FixtureEmbeddingProvider: 등록되지 않은 문장 "${t}"`);
      return Float32Array.from(v);
    });
  }
}

/**
 * 운영 공급자 팩토리.
 *
 * 아직 어댑터가 없다 — 모델 가중치를 받을 수 있게 되면 여기서 ONNX 어댑터를 돌려준다.
 * null을 돌려주는 동안 의미 검색은 완전히 비활성이며, 규칙·학습 표현 검수만 동작한다
 * (기능이 조용히 반쯤 켜지는 것보다 아예 꺼져 있는 편이 낫다).
 */
export function createEmbeddingProviderFromEnv(env = process.env): EmbeddingProvider | null {
  void env; // 어댑터가 생기면 모델 경로·이름을 여기서 읽는다
  return null;
}
