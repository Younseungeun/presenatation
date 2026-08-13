import type { Prisma, PrismaClient } from '@prisma/client';
import {
  applyRules,
  decide,
  findingMessages,
  mergeFindings,
  resolveAction,
  type ComplianceDecision,
  type ComplianceResult,
  type Finding,
  type RiskCategory,
  type ScreeningInput,
} from '@/domain/compliance';
import {
  calibrationExamples,
  summarizeAccuracy,
  type CalibrationExample,
  type LabeledReview,
  type OperatorVerdict,
} from '@/domain/screeningAccuracy';
import { matchLearnedPhrases, type LearnedPhrase } from '@/domain/learnedPhrases';
import type { IndexedPhrase } from '@/domain/semanticIndex';
import {
  createEmbeddingProviderFromEnv,
  type EmbeddingProvider,
} from '@/infra/embedding/provider';
import {
  deliberationRatio,
  type ComplianceScreener,
  type ScreeningOutput,
  type ScreeningUsage,
} from '@/infra/compliance/screener';
import { buildJudgmentWrites } from './judgmentWriter';
import { getActiveLearnedPhrases } from './learnedPhraseService';
import { findSemanticFindings, loadSemanticIndex } from './semanticIndexService';

// 게시 전 컴플라이언스 검수 실행·기록.
//
// 순서: 결정적 규칙 → (규칙이 차단하지 않았으면) AI 검수 → 병합 → 결정 → 기록.
// 규칙이 이미 BLOCK을 냈으면 AI를 호출하지 않는다 (결과가 바뀌지 않는데 비용·지연만 든다).

/**
 * 검수 실행에 붙는 운영 데이터.
 * 둘 다 운영자의 판정에서 나온다 — 이 시스템이 시간이 지날수록 나아지는 두 통로다.
 */
export interface ScreeningContext {
  /** AI 프롬프트에 붙일 과거 오탐 사례 */
  calibration?: CalibrationExample[];
  /** 운영자가 반려하며 등록한 학습 표현 (규칙과 동등하게 1차에서 적용) */
  phrases?: LearnedPhrase[];
  /**
   * 같은 사전의 의미 벡터 인덱스 + 임베딩 공급자.
   * 둘 다 있을 때만 의미 검색이 돈다 — 공급자가 없으면 이 단계는 완전히 비활성이다
   * (기능이 조용히 반쯤 켜지는 것보다 아예 꺼져 있는 편이 낫다).
   */
  semantic?: { entries: IndexedPhrase[]; provider: EmbeddingProvider };
}

/** 검수 실행 (기록 없음) — 순수 조합 로직이라 테스트가 쉽다 */
export async function runScreening(
  input: ScreeningInput,
  screener: ComplianceScreener | null,
  ctx: ScreeningContext = {},
): Promise<ComplianceResult> {
  // 학습 표현은 결정적 규칙과 같은 1차 단계다 — 다만 심각도는 항상 WARN이라
  // 즉시 거절을 유발하지 않는다 (ruleDecision은 코드 규칙만으로 판단).
  const codeFindings = applyRules(input);
  const ruleDecision = decide(codeFindings);
  const phraseFindings = matchLearnedPhrases(input, ctx.phrases ?? []);
  // 의미 검색: 글자가 달라도 뜻이 같은 표현. 실패해도 게시를 막지 않는다 —
  // 보조 신호이므로 장애가 검수 전체를 세우면 안 된다.
  const semanticFindings = ctx.semantic
    ? await findSemanticFindings(
        input,
        ctx.semantic.entries,
        ctx.semantic.provider,
        phraseFindings.flatMap((f) => (f.phraseId ? [f.phraseId] : [])),
      ).catch((e) => {
        console.error('의미 검색 실패:', e);
        return [];
      })
    : [];
  const ruleFindings = [...codeFindings, ...phraseFindings, ...semanticFindings];

  // 규칙이 차단했거나 AI 검수기가 없으면 규칙 결과가 최종
  if (ruleDecision === 'BLOCK' || !screener) {
    const decision = decide(ruleFindings);
    return {
      decision,
      action: resolveAction(ruleDecision, decision),
      findings: ruleFindings,
      reviewer: 'rule',
      needsOperatorReview: resolveAction(ruleDecision, decision) === 'HOLD',
    };
  }

  let output: ScreeningOutput;
  try {
    output = await screener.screen(input, ctx.calibration ?? []);
  } catch (e) {
    // 검수 실패로 게시를 거절하지는 않는다 — 외부 장애로 정상 리포트가 반려되면 안 된다.
    // 대신 판매도 시작하지 않고 운영자 검토로 돌린다.
    console.error('컴플라이언스 AI 검수 실패:', e);
    return {
      decision: 'UNAVAILABLE',
      action: 'HOLD',
      findings: ruleFindings,
      reviewer: `rule+${screener.reviewerId}(실패)`,
      needsOperatorReview: true,
    };
  }

  const findings = mergeFindings(ruleFindings, output.findings);
  const decision = decide(findings);
  const action = resolveAction(ruleDecision, decision);
  return {
    decision,
    action,
    findings,
    reviewer: `rule+${screener.reviewerId}`,
    needsOperatorReview: action === 'HOLD',
    usage: output.usage,
  };
}

/** 검수 실행 + 이력 기록. 차단된 시도도 남긴다 (반복 위반 탐지 근거) */
export async function screenAndRecord(
  prisma: PrismaClient,
  reportId: string,
  input: ScreeningInput,
  screener: ComplianceScreener | null,
  now = new Date(),
): Promise<ComplianceResult> {
  // 운영자 판정이 다음 검수로 되돌아오는 두 통로.
  // 조회 실패가 게시를 막으면 안 되므로 실패해도 빈 값으로 진행한다.
  const fallback = <T>(e: unknown, empty: T): T => {
    console.error('검수 보조 데이터 조회 실패:', e);
    return empty;
  };
  const [calibration, phrases] = await Promise.all([
    screener
      ? getCalibrationExamples(prisma).catch((e) => fallback(e, [] as CalibrationExample[]))
      : Promise.resolve([] as CalibrationExample[]),
    getActiveLearnedPhrases(prisma).catch((e) => fallback(e, [] as LearnedPhrase[])),
  ]);
  const embedder = createEmbeddingProviderFromEnv();
  const semantic = embedder
    ? {
        entries: await loadSemanticIndex(prisma, embedder).catch((e) =>
          fallback(e, [] as IndexedPhrase[]),
        ),
        provider: embedder,
      }
    : undefined;

  const result = await runScreening(input, screener, { calibration, phrases, semantic });
  const usage = result.usage as ScreeningUsage | undefined;

  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.complianceReview.create({
      data: {
        reportId,
        decision: result.decision,
        reviewer: result.reviewer,
        findingsJson: JSON.stringify(result.findings),
        needsOperatorReview: result.needsOperatorReview,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        deliberationRatio: usage ? deliberationRatio(usage) : null,
        createdAt: now,
      },
    }),
  ];

  // 학습 표현이 걸린 횟수를 센다 — 표현별 정확도(걸린 것 중 실제 반려 비율)의 분모
  const matchedPhraseIds = [
    ...new Set(result.findings.flatMap((f) => (f.phraseId ? [f.phraseId] : []))),
  ];
  if (matchedPhraseIds.length > 0) {
    writes.push(
      prisma.learnedPhrase.updateMany({
        where: { id: { in: matchedPhraseIds } },
        data: { matchCount: { increment: 1 }, lastMatchedAt: now },
      }),
    );
  }

  // 2단 검수로 결론이 나지 않은 건은 운영자에게 즉시 알린다.
  // 큐 페이지를 열어봐야만 알 수 있으면 위반 콘텐츠가 팔리는 시간이 길어진다.
  if (result.needsOperatorReview) {
    const operators = await prisma.user.findMany({
      where: { role: 'OPERATOR' },
      select: { id: true },
    });
    const label =
      result.decision === 'UNAVAILABLE'
        ? 'AI 검수 실패'
        : result.decision === 'BLOCK'
          ? 'AI 위반 판정'
          : '검수 경고';
    for (const op of operators) {
      writes.push(
        prisma.notification.create({
          data: {
            userId: op.id,
            type: 'COMPLIANCE_REVIEW',
            title: `[${label}] 게시 보류 — 검토 필요: ${input.title}`,
            body:
              result.decision === 'UNAVAILABLE'
                ? 'AI 검수가 실패해 결정적 규칙만 적용됐습니다. 게시를 보류했으니 본문을 확인해 게시 승인 또는 반려를 결정해주세요.'
                : `${findingMessages(result.findings).join(' / ')} — 게시를 보류했습니다. 본문을 확인해 게시 승인 또는 반려를 결정해주세요.`,
            link: '/admin/compliance',
            createdAt: now,
          },
        }),
      );
    }
  }

  await prisma.$transaction(writes);
  return result;
}

/**
 * 검수 비용·숙고량 통계 — 모델 선택과 에스컬레이션 임계값을 데이터로 정하기 위한 집계.
 * 운영 초기 수십 건만 쌓여도 실제 분포가 보인다.
 */
export async function getScreeningUsageStats(prisma: PrismaClient) {
  const rows = await prisma.complianceReview.findMany({
    where: { inputTokens: { not: null } },
    select: { inputTokens: true, outputTokens: true, deliberationRatio: true, decision: true },
    orderBy: { createdAt: 'desc' },
    take: 1_000,
  });
  if (rows.length === 0) return null;

  const sum = (pick: (r: (typeof rows)[number]) => number) =>
    rows.reduce((acc, r) => acc + pick(r), 0);
  const ratios = rows
    .map((r) => r.deliberationRatio ?? 0)
    .sort((a, b) => a - b);
  const percentile = (p: number) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))];

  return {
    samples: rows.length,
    avgInputTokens: Math.round(sum((r) => r.inputTokens ?? 0) / rows.length),
    avgOutputTokens: Math.round(sum((r) => r.outputTokens ?? 0) / rows.length),
    // 임계값 후보 — 상위 10~20%를 자르는 선이 에스컬레이션 기준이 된다
    ratioP50: percentile(0.5),
    ratioP80: percentile(0.8),
    ratioP90: percentile(0.9),
  };
}

/**
 * 운영자 검토 대기 큐 — 보류가 오래된 순.
 * 정렬 기준이 보류 경과 시간인 이유: 리서처는 결정이 날 때까지 판매를 못 한다.
 * 대기가 길어질수록 예측의 가치가 떨어지므로(특히 단기 카드) 오래된 건이 먼저다.
 */
export function getPendingComplianceReviews(prisma: PrismaClient) {
  return prisma.complianceReview.findMany({
    where: { needsOperatorReview: true, operatorReviewedAt: null },
    include: {
      report: {
        select: {
          id: true,
          title: true,
          status: true,
          researcher: {
            // tier는 정렬 기준(리서처 등급)에 쓰인다
            select: { id: true, tier: true, user: { select: { penName: true, email: true } } },
          },
          // 강제 철회 시 환불될 규모 — 운영자가 집행 전에 영향 범위를 보고 판단해야 한다
          purchases: { where: { escrowStatus: 'HELD' }, select: { amountKrw: true } },
          // 검증 시한 — 대기 중 시한이 다가오면 승인해도 게시 조건을 못 맞출 수 있다
          predictionCard: { select: { deadline: true, assetClass: true } },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * 판매 중 리포트 목록 (최근순) — 강제 철회의 진입점.
 * 검토 큐는 "보류 중"만 담기 때문에, 승인 후 문제가 드러난 리포트를 내리려면
 * 판매 중인 것들을 볼 수 있어야 한다.
 */
export function getPublishedReportsForOversight(prisma: PrismaClient, limit = 20) {
  return prisma.report.findMany({
    where: { status: 'PUBLISHED' },
    select: {
      id: true,
      title: true,
      status: true,
      publishedAt: true,
      researcher: {
        select: { id: true, tier: true, user: { select: { penName: true, email: true } } },
      },
      purchases: { where: { escrowStatus: 'HELD' }, select: { amountKrw: true } },
      predictionCard: { select: { deadline: true } },
      _count: { select: { purchases: true } }, // 판매량 정렬 기준 (환불 건 포함 누적)
    },
    orderBy: { publishedAt: 'desc' },
    take: limit,
  });
}

/**
 * 리서처별 누적 판매 건수 — 보류 건 정렬(판매량)에 쓴다.
 * 보류 중인 리포트는 아직 판매 전이라 자기 판매량이 0이므로,
 * "이 리서처가 얼마나 팔아온 사람인가"를 대신 본다.
 */
export async function researcherSalesCounts(
  prisma: PrismaClient,
  researcherIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (researcherIds.length === 0) return counts;

  const rows = await prisma.report.findMany({
    where: { researcherId: { in: researcherIds } },
    select: { researcherId: true, _count: { select: { purchases: true } } },
  });
  for (const r of rows) {
    counts.set(r.researcherId, (counts.get(r.researcherId) ?? 0) + r._count.purchases);
  }
  return counts;
}

// ── 운영자 판정 기록 (정답 라벨) ──────────────────────────────────────
//
// 운영자의 결정은 큐에서 건을 내리는 행위이자, 검수가 맞았는지에 대한 유일한 정답이다.
// 그래서 종결 처리와 라벨 기록을 같은 쓰기로 묶는다 — 따로 두면 라벨이 비어 있는
// 종결 건이 쌓여 측정이 불가능해진다.

export interface VerdictLabel {
  /** 반려·철회 사유 */
  reason?: string;
  /** 운영자가 확인한 실제 위반 유형 (비우면 검수 소견을 그대로 인정) */
  categories?: RiskCategory[];
  /** 승인 시: 지적 자체는 타당했는가 (경미해서 승인한 경우 true) */
  findingsValid?: boolean;
}

/**
 * 리포트의 검수 건에 운영자 판정을 기록하는 쓰기 (호출자의 트랜잭션에 합류).
 *
 * 대기 중인 건이 있으면 그것들에, 없으면 **가장 최근 검수 건**에 기록한다.
 * 후자가 중요하다: 검수를 통과(PASS)해 게시된 리포트가 나중에 강제 철회되면
 * 대기 건이 없는데, 바로 그 경우가 미탐(놓친 위반)의 유일한 관측 경로다.
 */
export async function operatorVerdictWrites(
  prisma: PrismaClient,
  reportId: string,
  verdict: OperatorVerdict,
  operatorUserId: string,
  now: Date,
  label: VerdictLabel = {},
): Promise<Prisma.PrismaPromise<unknown>[]> {
  const data = {
    operatorReviewedAt: now,
    operatorReviewedBy: operatorUserId,
    operatorVerdict: verdict,
    operatorReason: label.reason?.trim() || null,
    operatorCategories: label.categories?.length ? JSON.stringify(label.categories) : null,
    aiFindingsValid: label.findingsValid ?? null,
  };

  const [pendingCount, latest] = await Promise.all([
    prisma.complianceReview.count({
      where: { reportId, needsOperatorReview: true, operatorReviewedAt: null },
    }),
    prisma.complianceReview.findFirst({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, findingsJson: true },
    }),
  ]);

  // 학습 표현의 정확도 라벨 — 이 표현이 걸린 건이 실제 반려로 확정됐는가.
  // 규칙·AI와 같은 잣대를 사전에도 적용해야 오탐 표현이 영원히 남지 않는다.
  const confirmedPhraseIds =
    verdict === 'REJECTED' || verdict === 'TAKEDOWN' ? confirmedPhrases(latest, label) : [];
  const phraseWrites = confirmedPhraseIds.length
    ? [
        prisma.learnedPhrase.updateMany({
          where: { id: { in: confirmedPhraseIds } },
          data: { confirmedCount: { increment: 1 } },
        }),
      ]
    : [];

  if (pendingCount > 0) {
    return [
      prisma.complianceReview.updateMany({
        where: { reportId, needsOperatorReview: true, operatorReviewedAt: null },
        data,
      }),
      ...phraseWrites,
    ];
  }
  if (!latest) return [];
  return [prisma.complianceReview.update({ where: { id: latest.id }, data }), ...phraseWrites];
}

/**
 * 반려·철회로 확정된 학습 표현 id.
 * 운영자가 실제 위반 유형을 따로 지목했다면 그 유형의 표현만 인정한다 —
 * "반려는 맞았지만 이 표현 때문은 아니었다"를 구분해야 사전이 정확해진다.
 */
function confirmedPhrases(
  review: { findingsJson: string } | null,
  label: VerdictLabel,
): string[] {
  if (!review) return [];
  let findings: Finding[] = [];
  try {
    const parsed = JSON.parse(review.findingsJson);
    if (Array.isArray(parsed)) findings = parsed as Finding[];
  } catch {
    return [];
  }
  const actual = label.categories?.length ? new Set(label.categories) : null;
  return [
    ...new Set(
      findings.flatMap((f) =>
        f.phraseId && (actual === null || actual.has(f.category)) ? [f.phraseId] : [],
      ),
    ),
  ];
}

/** 운영자 확인 처리 — 판매 중 리포트를 검토 후 유지 (큐에서 제거 + 라벨 기록) */
export async function markComplianceReviewed(
  prisma: PrismaClient,
  reviewId: string,
  operatorUserId: string,
  now = new Date(),
) {
  await prisma.complianceReview.update({
    where: { id: reviewId, operatorReviewedAt: null },
    data: {
      operatorReviewedAt: now,
      operatorReviewedBy: operatorUserId,
      operatorVerdict: 'KEPT',
    },
  });
}

// ── 정확도 집계·되먹임 ────────────────────────────────────────────────

type ReviewRow = {
  decision: string;
  findingsJson: string;
  operatorVerdict: string | null;
  operatorReason: string | null;
  operatorCategories: string | null;
  aiFindingsValid: boolean | null;
};

/** DB 행 → 도메인 표본. 저장된 JSON은 방어적으로 파싱한다 (구버전 행 존재) */
function toLabeledReview(row: ReviewRow): LabeledReview {
  const parse = <T>(json: string | null, fallback: T): T => {
    if (!json) return fallback;
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    decision: row.decision as ComplianceDecision,
    findings: parse<Finding[]>(row.findingsJson, []),
    verdict: (row.operatorVerdict as OperatorVerdict | null) ?? null,
    findingsValid: row.aiFindingsValid,
    actualCategories: parse<RiskCategory[]>(row.operatorCategories, []),
    operatorReason: row.operatorReason,
  };
}

const LABEL_SELECT = {
  decision: true,
  findingsJson: true,
  operatorVerdict: true,
  operatorReason: true,
  operatorCategories: true,
  aiFindingsValid: true,
} as const;

/**
 * 검수 정확도 — 운영자 판정이 붙은 건만 집계한다.
 * 이 수치가 축 2(모델 캐스케이드)·축 3(리스크 기반 차등)의 판단 근거가 된다.
 */
export async function getScreeningAccuracy(prisma: PrismaClient, take = 500) {
  const rows = await prisma.complianceReview.findMany({
    where: { operatorVerdict: { not: null } },
    select: LABEL_SELECT,
    orderBy: { createdAt: 'desc' },
    take,
  });
  return summarizeAccuracy(rows.map(toLabeledReview));
}

/**
 * 유형별 실제 결과 — 작성 화면 경고 문구의 강도를 사실로 조절하기 위한 자료.
 *
 * 오탐률이 높은 유형까지 "게시가 보류됩니다"라고 똑같이 겁을 주면, 리서처는 곧
 * 경고 전체를 무시하게 된다. 그렇다고 표시를 죽이면 서버는 여전히 보류시키므로
 * 화면이 거짓말을 하게 된다. 그래서 **사실을 덧붙인다**:
 * "이 유형으로 보류된 최근 N건 중 M건은 검토 후 승인됐습니다."
 */
export async function getCategoryOutcomeRates(prisma: PrismaClient, take = 500) {
  const summary = await getScreeningAccuracy(prisma, take);
  const rates: Partial<Record<RiskCategory, { flagged: number; approved: number }>> = {};
  for (const c of summary.byCategory) {
    if (c.flagged > 0) rates[c.key] = { flagged: c.flagged, approved: c.falsePositive };
  }
  return rates;
}

/**
 * AI에게 되먹일 오탐 사례.
 * 운영자가 "이건 지적할 게 아니었다"고 판정한 실제 문장을 프롬프트에 넣어
 * 같은 오탐이 반복되지 않게 한다 — 모델을 바꾸지 않고 정확도를 올리는 가장 싼 수단.
 */
export async function getCalibrationExamples(
  prisma: PrismaClient,
  limit = 8,
): Promise<CalibrationExample[]> {
  const rows = await prisma.complianceReview.findMany({
    // 오탐 후보: 승인·유지로 끝났는데 지적이 타당했다는 표시가 없는 건
    where: {
      operatorVerdict: { in: ['APPROVED', 'KEPT'] },
      NOT: { aiFindingsValid: true },
    },
    select: LABEL_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit * 6, // 규칙 오탐·중복이 걸러지므로 넉넉히 조회한다
  });
  return calibrationExamples(rows.map(toLabeledReview), limit);
}

// ── 강제 철회 (운영자 집행 액션) ────────────────────────────────────────
//
// 검토 큐의 WARN·UNAVAILABLE 건을 확인한 결과 실제로 위반이라고 판단했을 때,
// 이미 게시된 리포트를 운영자가 내린다. 확인 도장만 찍는 큐는 집행 수단이 없어
// 규제 리스크를 실제로 줄이지 못한다.
//
// 원칙:
// - 구매자 보호 우선: 시한을 기다리지 않고 즉시 판정 불가(WITHDRAWN) 처리 →
//   에스크로 전액 환불, 플랫폼 수수료 0, 리서처 정산 0 (§2.5·§3.3)
// - 리서처 점수는 0점 (표본 제외) — 위반 콘텐츠가 트랙레코드에 남지 않게
// - 판정·정산·알림은 자동 경로와 동일 함수(buildJudgmentWrites) 공유
// - 사유 필수 + 운영자 식별자를 감사 스냅샷에 기록 (분쟁 재현·이의 제기 대응)
// - 기록은 지우지 않는다: 카드·리포트·검수 이력 모두 보존하고 상태만 CLOSED로 전이

export class ComplianceTakedownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceTakedownError';
  }
}

export interface TakedownInput {
  reportId: string;
  operatorUserId: string;
  /** 강제 철회 사유 — 필수. 리서처 알림과 감사 스냅샷에 그대로 실린다 */
  reason: string;
  /** 실제 위반 유형 (선택) — 통과된 건을 철회했다면 검수가 못 잡은 유형이 된다 */
  categories?: RiskCategory[];
}

export interface TakedownSummary {
  reportId: string;
  /** 환불 대상이 된 에스크로 보관 구매 건수 */
  refundedPurchases: number;
  refundedAmountKrw: number;
}

export async function forceWithdrawReport(
  prisma: PrismaClient,
  input: TakedownInput,
  now = new Date(),
): Promise<TakedownSummary> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ComplianceTakedownError('강제 철회 사유는 필수입니다');
  }

  const report = await prisma.report.findUnique({
    where: { id: input.reportId },
    include: {
      purchases: { where: { escrowStatus: 'HELD' } },
      researcher: { select: { userId: true } },
      predictionCard: { include: { judgment: { select: { id: true } } } },
    },
  });
  if (!report) throw new ComplianceTakedownError('리포트를 찾을 수 없습니다');
  if (report.status !== 'PUBLISHED') {
    throw new ComplianceTakedownError(
      report.status === 'DRAFT'
        ? '게시되지 않은 초안은 강제 철회 대상이 아닙니다'
        : '이미 철회·종료된 리포트입니다',
    );
  }
  const card = report.predictionCard;
  if (!card) throw new ComplianceTakedownError('예측 카드가 없습니다');
  if (card.judgment) {
    throw new ComplianceTakedownError(
      '이미 판정이 완료된 카드입니다 — 정산이 끝난 건은 철회할 수 없습니다',
    );
  }
  if (card.withdrawnAt) throw new ComplianceTakedownError('이미 철회된 카드입니다');

  const audit = {
    takedown: true,
    operatorUserId: input.operatorUserId,
    reason,
    reportId: report.id,
    withdrawnAt: now.toISOString(),
  };

  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.predictionCard.update({ where: { id: card.id }, data: { withdrawnAt: now } }),
    prisma.report.update({
      // 동시 요청 대비: PUBLISHED 조건을 다시 걸어 원자적으로 전이
      where: { id: report.id, status: 'PUBLISHED' },
      data: { status: 'CLOSED' },
    }),
    // 판정 불가(WITHDRAWN) 즉시 확정 → 전액 환불 지시서 + 당사자 알림까지 자동 경로와 동일
    ...buildJudgmentWrites(
      prisma,
      { ...card, report: { ...report, purchases: report.purchases } },
      {
        result: { outcome: 'UNDECIDABLE', undecidableReason: 'WITHDRAWN' },
        realizedReturnPct: null,
        score: 0, // 판정 불가는 표본 제외 (§2.2)
        info: 0, // 증거도 없다 — 규율 래더에 들어가면 안 된다
        dataSource: `takedown:${input.operatorUserId}`,
        audit,
      },
      now,
    ),
    // 사유가 담긴 별도 통지 — 리서처가 무엇을 고쳐야 하는지 알아야 재발이 줄어든다
    prisma.notification.create({
      data: {
        userId: report.researcher.userId,
        type: 'COMPLIANCE_TAKEDOWN',
        title: `운영자 강제 철회: ${report.title}`,
        body: `컴플라이언스 검토 결과 게시가 중단되었습니다. 사유: ${reason} · 구매자에게는 전액 환불되며 이 카드는 점수에 반영되지 않습니다.`,
        link: `/report/${report.id}`,
        createdAt: now,
      },
    }),
    // 집행 결과를 검수 기록에 라벨로 남긴다.
    // 검수를 통과했던 건이면 이것이 미탐(놓친 위반)의 기록이 된다.
    ...(await operatorVerdictWrites(prisma, report.id, 'TAKEDOWN', input.operatorUserId, now, {
      reason,
      categories: input.categories,
    })),
  ];

  await prisma.$transaction(writes);

  return {
    reportId: report.id,
    refundedPurchases: report.purchases.length,
    refundedAmountKrw: report.purchases.reduce((sum, p) => sum + p.amountKrw, 0),
  };
}
