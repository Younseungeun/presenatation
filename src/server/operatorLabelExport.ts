import type { PrismaClient } from '@prisma/client';
import { COHERENCE_CORPUS } from '@/domain/__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from '@/domain/__fixtures__/screeningCorpus';
import type { ComplianceDecision, Finding, RiskCategory, ScreeningInput } from '@/domain/compliance';
import {
  DEFAULT_CLEAN_SAMPLE_RATIO,
  summarizeOperatorExamples,
  toOperatorLabels,
  type OperatorExportOptions,
  type OperatorLabelResult,
} from '@/domain/operatorTraining';
import type { OperatorVerdict } from '@/domain/screeningAccuracy';
import { buildStudentText, type TrainingExample } from '@/domain/studentText';
import { targetPriceToMagnitudePct } from '@/domain/scoring';

// **운영자 판정 → 학습 자료** (DB 쪽). 순수 판단은 domain/operatorTraining.ts 에 있다.
//
// 관리자 앱은 이 함수를 부르는 버튼 하나만 있으면 된다.

/** 채점지를 베끼지 않는다 — addTrainingCase·ingestGenerated 와 **같은 값**이어야 한다 */
const LEAK_THRESHOLD = 0.6;

function trigrams(s: string): Set<string> {
  const t = s.replace(/[^가-힣a-zA-Z0-9]/g, '');
  const out = new Set<string>();
  for (let i = 0; i + 3 <= t.length; i += 1) out.add(t.slice(i, i + 3));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit += 1;
  return hit / (a.size + b.size - hit);
}

export interface OperatorExportResult {
  examples: TrainingExample[];
  counts: ReturnType<typeof summarizeOperatorExamples>;
  /** 채점지와 겹쳐서 버린 건수 — 0이 아니면 코퍼스가 운영 데이터에 샜다는 뜻이다 */
  leaked: number;
  /** 판정은 있으나 자료가 될 수 없던 건수 (경미·유형 미지목 미탐 등) */
  skipped: number;
  /** 열람→판정이 너무 빨라(피로 의심) 라벨로 믿지 않은 건수 (27차 ③) */
  fatigued: number;
}

/**
 * @근거 설계 — 소견 한 줄과 인용문을 읽는 데 필요한 최소 시간. 3초 밑의 '승인'은
 *   판단이 아니라 반사다. 값은 출시 후 판단 소요 시간 분포(첫 주 0점)로 재조정한다.
 */
const MIN_DECISION_MS = 3_000;

/**
 * 운영자가 판정한 검수 기록을 학생 모델 학습 형식으로 뽑는다.
 *
 * **게시 경로와 같은 직렬화를 쓴다**(`buildStudentText`). 여기서 다르게 만들면
 * 화면에서 본 것과 학습에 들어간 것이 갈라지고, 그 어긋남은 성능 저하로만 나타나
 * 원인을 찾을 수 없다.
 *
 * **예측 카드를 반드시 함께 넣는다** — 운영의 입력에는 언제나 카드가 있다.
 * 카드 없이 학습시키면 12차에 고친 결함(빈 카드로 측정)을 학습 쪽에서 다시 만든다.
 */
export async function exportOperatorLabels(
  prisma: PrismaClient,
  opts: OperatorExportOptions & { since?: Date; limit?: number } = {},
): Promise<OperatorExportResult> {
  const reviews = await prisma.complianceReview.findMany({
    where: {
      operatorVerdict: { not: null },
      ...(opts.since ? { createdAt: { gte: opts.since } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.limit ?? 5000,
    // 교사 답을 함께 읽는다 — 라벨 출처에 교사 표식을 실으려면 필요하다 (18차 V-4).
    // **값을 합치지는 않는다**: 운영자 판정이 라벨이고 교사는 출처 표시일 뿐이다
    include: { report: { include: { predictionCard: true } }, teacherAnswer: true },
  });

  const judged = [
    ...SCREENING_CORPUS.map((i) => i.text),
    ...COHERENCE_CORPUS.map((i) => i.text),
  ].map(trigrams);

  // **피로 판정은 정답이 아니다** (27차 넷째 범주 ③ — 운영자 피로도 오염).
  // 열람→판정이 MIN_DECISION_MS 미만인 **승인**은 소견을 읽지 않고 누른 것으로 보고 학습
  // 라벨에서 뺀다. 안 읽고 누른 '승인'이 하드 네거티브로 들어가면 모델은 "그 소견은
  // 오탐"을 배우고, 다음엔 진짜 위반에 침묵한다 — 피로가 모델로 전염되는 경로를 끊는다.
  //
  // **승인만 본다 (28차 EE-4)**: 단일 하한은 틀렸다 — 노골적 연락처 유도 같은 "즉시 거절급
  // 정탐"은 1초 만에 반려해도 옳고, 그 반려를 버리면 귀중한 정탐 자료가 날아간다. 피로의
  // 모양은 "빠른 승인"이지 "빠른 반려"가 아니다. 라벨×승인/반려 조건별 분포는 출시 첫 주
  // 0점(DD-5 1순위)을 받은 뒤 정한다 — 그때까지 이 하한은 승인 쪽에만 건다.
  // (새 칸이라 클라이언트 타입 재생성 전에도 돌아야 해서 raw 로 읽는다)
  const fatiguedIds = new Set(
    (
      await prisma.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "ComplianceReview"
        WHERE "operatorVerdict" = 'APPROVED'
          AND "decisionElapsedMs" IS NOT NULL AND "decisionElapsedMs" < ${MIN_DECISION_MS}`
    ).map((x) => x.id),
  );

  const examples: TrainingExample[] = [];
  const results: OperatorLabelResult[] = [];
  let leaked = 0;
  let skipped = 0;
  let fatigued = 0;

  for (const r of reviews) {
    if (fatiguedIds.has(r.id)) {
      fatigued += 1;
      continue;
    }
    const findings = parseJson<Finding[]>(r.findingsJson, []);
    const decided = toOperatorLabels(
      {
        decision: r.decision as ComplianceDecision,
        findings,
        verdict: r.operatorVerdict as OperatorVerdict | null,
        findingsValid: r.aiFindingsValid,
        actualCategories: parseJson<RiskCategory[]>(r.operatorCategories, []),
      },
      opts,
    );
    if (!decided) {
      skipped += 1;
      continue;
    }
    // **정탐 앵커 표본** (17차 U-6) — 통째로 빼면 학생이 아는 위반을 잊고(치명적 망각),
    // 통째로 넣으면 규칙의 그림자가 된다. id 해시로 뽑아 **실행마다 같은 표본**이 나오게
    // 한다 — 돌릴 때마다 달라지면 재학습 결과를 견줄 수 없다
    if (decided.kind === 'operator_confirmed' && !opts.includeConfirmed) {
      const ratio = opts.confirmedAnchorRatio ?? 0;
      if (stableFraction(r.id) >= ratio) {
        skipped += 1;
        continue;
      }
    }

    // **정상 통과분 표본** (18차 V-7) — 수동 2차의 라벨은 보류된 건에서만 나와
    // 학습셋이 위반 쪽으로 구조적으로 쏠린다. 같은 안정 표집으로 되돌린다
    if (decided.kind === 'operator_clean' && !opts.includeClean) {
      const ratio = opts.cleanSampleRatio ?? DEFAULT_CLEAN_SAMPLE_RATIO;
      // 해시를 그대로 쓰면 정탐 앵커와 **같은 건들**이 뽑힌다(두 표본이 상관된다).
      // 접두를 달리해 서로 독립인 표본을 만든다
      if (stableFraction(`clean:${r.id}`) >= ratio) {
        skipped += 1;
        continue;
      }
    }

    const body = r.report.content;
    const mine = trigrams(body);
    if (judged.some((j) => jaccard(mine, j) >= LEAK_THRESHOLD)) {
      leaked += 1;
      continue;
    }

    const card = r.report.predictionCard;
    const input: ScreeningInput = {
      title: r.report.title,
      summary: r.report.summary,
      content: body,
      assetClass: (card?.assetClass as ScreeningInput['assetClass']) ?? 'KR_EQUITY',
      assetName: card?.assetName ?? '',
      direction: card?.direction === 'DOWN' ? 'DOWN' : 'UP',
      targetType: (card?.targetType as ScreeningInput['targetType']) ?? undefined,
      magnitudePct: cardMagnitude(card),
      horizonDays: card ? daysUntil(card.deadline, r.createdAt) : null,
      confidence: card?.confidence ?? null,
      sigmaDaily: card?.sigmaDaily ?? null,
    };

    examples.push({
      id: `op:${r.id}`,
      source: 'operator',
      kind: decided.kind,
      text: buildStudentText(input),
      labels: decided.labels,
      // **누가 판정했는지 남긴다** — 나중에 특정 운영자의 판정이 의심되면
      // 그것만 빼고 재학습할 수 있어야 한다 (train.py --exclude-labeler)
      //
      // 교사 표식은 **접미로** 붙인다 (18차 V-4). `train.py --exclude-labeler` 가
      // 접두 일치라(`startswith`), 앞을 건드리면 기존 제외 규칙이 조용히 안 먹는다.
      // 접미로 두면 `operator:` 로도 `operator:<id>|teacher:<표식>` 로도 걸린다.
      //
      // 왜 남기나: 대화창의 교사는 버전이 오른다. 표식이 없으면 교사가 바뀐 전후의
      // 라벨을 섞어 재학습하게 되고, 그 사실조차 나중에 알 수 없다
      labeler:
        `operator:${r.operatorReviewedBy ?? 'unknown'}` +
        (r.teacherAnswer ? `|teacher:${r.teacherAnswer.teacherTag}` : ''),
    });
    results.push(decided);
  }

  return { examples, counts: summarizeOperatorExamples(results), leaked, skipped, fatigued };
}

/** id 로부터 0~1 의 안정적인 값 — 같은 건은 언제나 같은 쪽에 떨어진다 */
function stableFraction(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * 예측 크기(%) — 수익률형은 그대로, 목표가형은 기준가 대비로 환산한다.
 * 기준가가 아직 없는 소급 확정 카드는 null (지어내지 않는다).
 */
function cardMagnitude(card: { targetType: string; targetValue: number; basePrice: number | null } | null): number | null {
  if (!card) return null;
  if (card.targetType === 'RETURN_PCT') return card.targetValue;
  if (card.basePrice == null || card.basePrice <= 0) return null;
  return targetPriceToMagnitudePct(card.targetValue, card.basePrice);
}

/** 검수 시점에서 시한까지 남았던 일수 — 검수 당시의 카드를 그대로 재현한다 */
function daysUntil(deadline: Date, from: Date): number {
  return Math.max(0, Math.round((deadline.getTime() - from.getTime()) / 86_400_000));
}
