import Anthropic from '@anthropic-ai/sdk';
import {
  RISK_CATEGORIES,
  RISK_CATEGORY_LABEL,
  type Finding,
  type RiskCategory,
  type ScreeningInput,
  type Severity,
} from '@/domain/compliance';
import { ASSET_CLASS_LABEL } from '@/domain/constants';
import { RISK_LEVEL_LABEL } from '@/domain/instrumentRisk';
import type { ComplianceScreener, ScreeningOutput } from './screener';

// Claude 기반 컴플라이언스 검수 어댑터.
// 결정적 규칙이 놓치는 우회 표현·문맥 의존 위반을 찾는다.
//
// 설계 요점:
// - 구조화 출력(output_config.format)으로 스키마를 강제 — 응답 파싱 실패를 없앤다
// - 오탐 억제가 최우선: 정상 리서처의 게시를 막으면 공급(1단계 전략)이 무너진다.
//   프롬프트에서 "일반적인 분석·전망은 위반이 아니다"를 반복해 명시한다
// - 실패(장애·거부)는 예외로 던진다 — 호출자가 UNAVAILABLE로 처리해 게시는 통과시키고
//   운영자 검토 대상으로 돌린다 (외부 장애가 서비스 중단으로 번지지 않게)

const MODEL = 'claude-opus-5';

/** 구조화 출력 스키마 — 응답이 이 형태임을 API가 보장한다 */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: '발견된 위반. 위반이 없으면 빈 배열.',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: [...RISK_CATEGORIES] },
          severity: {
            type: 'string',
            enum: ['BLOCK', 'WARN'],
            description: 'BLOCK은 명백한 규제 위반일 때만. 애매하면 WARN.',
          },
          quote: { type: 'string', description: '문제가 된 원문 일부 (원문 그대로 인용)' },
          reason: {
            type: 'string',
            description: '리서처가 어떻게 고쳐야 하는지 알 수 있게 한국어 한두 문장으로.',
          },
        },
        required: ['category', 'severity', 'quote', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['findings'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `당신은 한국 투자 리서치 콘텐츠 마켓플레이스의 컴플라이언스 검수자입니다.
독립 리서처가 게시하려는 유료 분석 리포트에서 **규제 위반 소지가 있는 표현만** 찾아냅니다.

## 위반 유형
- PROFIT_GUARANTEE: 수익·원금을 보장하거나 손실을 보전해준다는 표현. 자본시장법상 손실보전·이익보장 금지에 저촉.
- PRIVATE_INFO: 미공개 중요정보를 알고 있음을 시사하는 표현(내부 관계자 전언, 공시 전 입수 등).
- RUMOR: 출처를 확인할 수 없는 풍문·찌라시를 근거로 제시하는 표현.
- SOLICIT_CONTACT: 1:1 상담·개인 연락·외부 채널(카톡, 텔레그램, 리딩방 등) 유도. 이 플랫폼은 불특정 다수 대상 리포트만 허용하며, 개별 자문은 투자자문업 영역이라 금지됩니다.
- UNSUPPORTED_CLAIM: 아무 근거 없이 단정하는 서술. 규제 위반은 아니므로 반드시 WARN.
- RISK_INDUCEMENT: 차입(빚투·신용·미수)·고배율 레버리지·전 재산 집중 투자를 권유하는 표현. 규제 위반이라기보다 소비자 피해로 직결되므로 WARN.
- MISSING_DISCLOSURE: 거래소가 위험을 경고한 종목인데(사용자 메시지에 표시됨) 본문이 변동성·거래 제한 가능성을 전혀 언급하지 않는 경우. WARN.

## 심각도
- BLOCK: 명백한 규제 위반. 게시가 보류되고 운영자가 최종 판단합니다.
- WARN: 위반 소지는 있으나 해석의 여지가 있는 경우. 역시 보류 후 운영자가 검토합니다.
두 경우 모두 게시가 즉시 거절되지는 않지만, 판매가 시작되지 않고 사람의 확인을 기다리게 됩니다.

## 가장 중요한 원칙: 오탐을 내지 마세요
이 플랫폼의 존재 이유가 투자 분석 리포트 판매입니다. **평범한 분석·전망·투자의견은 위반이 아닙니다.**
다음은 모두 정상이며 절대 지적하지 마세요:
- 목표주가·목표수익률 제시, 매수/매도 의견, "상승할 것으로 전망한다" 같은 예측
- 강한 확신의 표현("강력히 추천", "저평가 구간이라고 판단한다")
- 공개된 재무제표·공시·뉴스·업황 자료에 근거한 추정과 시나리오
- 리스크 고지, 일반적인 면책 문구

확신이 서지 않으면 지적하지 말고 넘어가세요. 놓친 위반은 운영자가 사후에 잡을 수 있지만,
잘못된 지적은 정상적인 리서처의 게시를 막습니다.

위반이 없으면 findings를 빈 배열로 반환하세요.`;

function buildUserMessage(input: ScreeningInput): string {
  const dir = input.direction === 'UP' ? '상승' : '하락';
  const risk =
    input.riskLevel && input.riskLevel !== 'NONE'
      ? `\n⚠ 이 종목은 거래소가 ${RISK_LEVEL_LABEL[input.riskLevel]} 종목으로 지정했습니다` +
        `${input.riskNote ? ` (${input.riskNote})` : ''}. 본문에 변동성·거래 제한 위험이 설명되어 있는지 확인하세요.`
      : '';
  return [
    `자산군: ${ASSET_CLASS_LABEL[input.assetClass]} / 종목: ${input.assetName} / 예측 방향: ${dir}${risk}`,
    '',
    '아래 리포트를 검수하세요.',
    '',
    `<제목>\n${input.title}\n</제목>`,
    '',
    `<요약>\n${input.summary}\n</요약>`,
    '',
    `<본문>\n${input.content}\n</본문>`,
  ].join('\n');
}

const VALID_CATEGORIES = new Set<string>(RISK_CATEGORIES);

/** 응답 → Finding[] (스키마가 보장되지만 방어적으로 한 번 더 좁힌다) */
export function parseFindings(raw: unknown): Finding[] {
  const list = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): Finding[] => {
    const f = item as Partial<Record<keyof Finding, string>>;
    if (!f.category || !VALID_CATEGORIES.has(f.category)) return [];
    const severity: Severity = f.severity === 'BLOCK' ? 'BLOCK' : 'WARN';
    return [
      {
        category: f.category as RiskCategory,
        // 근거 없는 단정은 규제 위반이 아니므로 차단하지 않는다 (모델이 BLOCK을 줘도 강등)
        severity: f.category === 'UNSUPPORTED_CLAIM' ? 'WARN' : severity,
        quote: (f.quote ?? '').slice(0, 300),
        reason: f.reason ?? RISK_CATEGORY_LABEL[f.category as RiskCategory],
      },
    ];
  });
}

export class ClaudeComplianceScreener implements ComplianceScreener {
  readonly reviewerId = `claude:${MODEL}`;

  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async screen(input: ScreeningInput): Promise<ScreeningOutput> {
    const response = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16_000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(input) }],
      output_config: {
        format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
        // 규정 대조는 짧은 분류 작업이라 medium이면 충분하다 (지연·비용 절감)
        effort: 'medium',
      },
      // 안전 분류기가 요청을 거절하면 서버가 대체 모델로 재실행한다.
      // 검수 실패로 게시가 막히는 상황을 줄이기 위한 안전장치.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      // SDK 타입에 아직 반영되지 않은 신규 파라미터(fallbacks)가 있어 캐스팅한다
    } as unknown as Parameters<Anthropic['beta']['messages']['create']>[0]);

    const message = response as Anthropic.Beta.BetaMessage;
    // 거부는 정상 응답(HTTP 200)으로 오므로 content를 읽기 전에 반드시 확인한다
    if (message.stop_reason === 'refusal') {
      throw new Error('컴플라이언스 검수 요청이 거부되었습니다 (safety classifier)');
    }

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) {
      throw new Error('컴플라이언스 검수 응답이 비어 있습니다');
    }
    return {
      findings: parseFindings(JSON.parse(text)),
      // 실제 비용 측정·숙고량 신호의 원천 (출력에는 사고 토큰이 포함된다)
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
    };
  }
}

/** ANTHROPIC_API_KEY가 있으면 Claude 검수기, 없으면 null (규칙 검수만 동작) */
export function createClaudeScreenerFromEnv(env = process.env): ComplianceScreener | null {
  if (!env.ANTHROPIC_API_KEY && !env.ANTHROPIC_AUTH_TOKEN) return null;
  return new ClaudeComplianceScreener();
}
