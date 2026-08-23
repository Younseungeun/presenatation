import type { RiskCategory, ScreeningInput } from './compliance';

// 학생(증류) 모델의 입출력 계약 — **여기 한 곳에만 정의한다.**
//
// 학습(training/train.py)은 JSONL의 text·labels를 그대로 읽고, 추론(앞으로의 브라우저·
// 서버 ONNX 어댑터)은 buildStudentText로 같은 문자열을 만든다. 학습 때와 다른 직렬화로
// 추론하면 지표가 조용히 무너지는데, 그 원인은 어디에도 예외로 나타나지 않는다 —
// 임베딩 벡터에 모델 식별자를 같이 저장하는 것과 같은 종류의 방어다.

/**
 * 학생 모델의 출력 라벨 공간 (이 순서가 곧 출력 벡터의 차원 순서다 — 학습·추론 공유).
 *
 * 문장에서 배울 수 있는 7유형 + 문서 단위 정합성 1비트 = 8차원 다중 라벨.
 * 두 과제를 헤드 둘로 나누지 않고 한 벡터로 합친 이유: 손실 가중치(pos_weight)로
 * 라벨 불균형을 다루면 구조가 같아지고, ONNX 내보내기·추론 배선이 절반이 된다.
 *
 * 제외한 유형과 이유:
 * - MISSING_DISCLOSURE: 본문만으로 판정 불가 — 종목 위험 플래그가 필요한 결합 판단
 * - RISKY_INSTRUMENT / UNREALISTIC_TARGET / UNJUDGEABLE_PATTERN: 텍스트가 아니라
 *   종목 데이터·카드 숫자·이력에서 나오는 판정 — 규칙이 이미 결정적으로 한다
 */
export const STUDENT_LABELS = [
  'PROFIT_GUARANTEE',
  'PRIVATE_INFO',
  'RUMOR',
  'SOLICIT_CONTACT',
  'UNSUPPORTED_CLAIM',
  'RISK_INDUCEMENT',
  'SCREENING_EVASION',
  'CARD_MISMATCH',
] as const satisfies readonly RiskCategory[];
export type StudentLabel = (typeof STUDENT_LABELS)[number];

export function isStudentLabel(c: RiskCategory): c is StudentLabel {
  return (STUDENT_LABELS as readonly RiskCategory[]).includes(c);
}

/**
 * 검수 입력 → 학생 모델 입력 문자열.
 *
 * **카드를 반드시 넣는다** — 카드를 뺀 모델은 본문–카드 모순(CARD_MISMATCH)을 영원히
 * 못 배운다 (CLAUDE.md 검수 로드맵의 확정 제약). 문장 단위 학습 예시는 하네스가 채우는
 * 중립 카드가 들어오므로 같은 형식이 유지된다.
 */
export function buildStudentText(input: ScreeningInput): string {
  const card: string[] = [`방향 ${input.direction === 'UP' ? '상승' : '하락'}`];
  if (input.targetType === 'TARGET_PRICE') card.push(`목표가 ${input.targetLabel ?? '-'}`);
  else if (input.magnitudePct != null) card.push(`목표 등락률 ${input.magnitudePct}%`);
  if (input.horizonDays != null) card.push(`시한 ${Math.max(1, Math.round(input.horizonDays))}일`);
  if (input.confidence != null) card.push(`신뢰도 ${input.confidence}/10`);
  return [
    `[카드] ${card.join(' / ')}`,
    `[제목] ${input.title}`,
    `[요약] ${input.summary}`,
    `[본문] ${input.content}`,
  ].join('\n');
}

/**
 * 학습 예시 한 건 = JSONL 한 줄. training/data/*.jsonl 의 형식이다.
 *
 * labels가 빈 배열이면 정상 예시다. labeler를 남기는 이유는 검수 소견의 source와 같다 —
 * 사람 라벨과 교사 라벨이 섞였을 때 어느 쪽이 오염됐는지 구분할 수 없으면 처방이 안 나온다.
 */
export interface TrainingExample {
  id: string;
  /**
   * 이 예시가 어디서 왔는가.
   * - `hand_corpus` 손코퍼스 (**채점지라 학습 금지**)
   * - `synthetic`   합성 생성 + 대화 라벨
   * - `founder`     창업자가 직접 써 보다 만난 사례 (12차 M-5)
   * - `operator`    출시 후 운영자 판정 (세 번째 원천 — 아직 0건)
   */
  source: 'hand_corpus' | 'synthetic' | 'founder' | 'operator';
  /** 코퍼스의 문장 종류 — 종류별 성적 분해에 쓴다 (합성 예시는 생성 의도) */
  kind: string;
  text: string;
  labels: StudentLabel[];
  labeler: string;
}
