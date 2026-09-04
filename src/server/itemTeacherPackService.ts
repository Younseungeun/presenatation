import type { PrismaClient } from '@prisma/client';
import { RISK_CATEGORIES, RISK_CATEGORY_LABEL, type Finding, type RiskCategory } from '@/domain/compliance';
import {
  assembleItemTeacherPack,
  classifyItemVerdict,
  type ItemEvidenceLine,
  type ItemPackLayer,
} from '@/domain/itemTeacherPack';
import { getDetectionLadder } from './detectionLadderService';
import { createLearnedPhrase } from './learnedPhraseService';
import { validatePhrase } from '@/domain/learnedPhrases';

// 검출 항목별 질문지의 **수집** (2026-09-01). 조립은 domain/itemTeacherPack(순수).
//
// 두 층의 증거 출처가 다르다 — 같은 모양으로 접어 조립기에 넘긴다:
//   · 학습표현: LearnedPhraseHit 스냅샷 (문맥·출현형·부정) — 걸린 순간을 박제한 표.
//     사람 판정은 hit.verdict 로 승인/반려/철회까지만 남고 "오탐 vs 경미"는 검수 기록의
//     aiFindingsValid 에 있어, 같은 리포트의 최신 판정 기록과 맞춰 4갈래로 접는다
//   · 규칙 WARN: ComplianceReview.findingsJson 의 소견 (quote=문맥, layer) + 그 기록의 판정.
//     규칙은 hit 표가 없다 — 소견 자체가 스냅샷이다
//
// **사람이 펼친 항목 하나만** 만든다(지연 로드) — 전 항목을 미리 만들면 목록이 hit 수만큼 무겁다.

export class ItemPackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ItemPackError';
  }
}

/** `argos:<유형>` — ARGOS 유형별 모음의 항목 id 접두어. 표의 버튼이 같은 컴포넌트를 그대로 쓴다 */
export const ARGOS_ITEM_PREFIX = 'argos:';

/** 이 판정들만 "확정 위반"이다 — 사다리·질문지와 같은 잣대 (MISSED = 통과 후 철회로 드러난 미탐) */
const CONFIRMED_VERDICTS = ['REJECTED', 'TAKEDOWN', 'MISSED'] as const;

/** 규칙·사전(·옛 AI 검수)이 낸 소견이 하나라도 있으면 "ARGOS 만 잡은 건"이 아니다 */
function hasNonStudentFinding(findings: Finding[]): boolean {
  // source 가 없는 옛 기록은 규칙 소견으로 본다(보수 — 모르면 ARGOS 몫으로 세지 않는다)
  return findings.some((f) => f.source !== 'student');
}

interface ArgosCase {
  categories: RiskCategory[];
  /** ARGOS 가 잡았나(학생 소견 있음) / 놓쳤나(통과 후 철회) */
  detected: boolean;
  evidence: string[];
  /** 이 근거가 나온 확정 건 — 본선 등록(ARGOS→사전)의 출처(sourceReportId)로 물린다 (Q1) */
  reportId: string;
  createdAt: Date;
}

/**
 * ARGOS 만 잡았거나 놓친 **확정** 건을 근거 문장과 함께 모은다 (2026-09-01).
 * 근거 문장(operatorEvidence)이 없는 건은 문장이 없어 재료가 못 된다 — 그래서
 * operatorVerdictWrites 가 이런 건에는 근거 문장을 **요구**한다.
 */
async function collectArgosCases(prisma: PrismaClient): Promise<ArgosCase[]> {
  const rows = await prisma.complianceReview.findMany({
    where: { operatorVerdict: { in: [...CONFIRMED_VERDICTS] }, operatorEvidence: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { reportId: true, findingsJson: true, operatorCategories: true, operatorEvidence: true, operatorVerdict: true, createdAt: true },
  });
  const out: ArgosCase[] = [];
  for (const r of rows) {
    let findings: Finding[] = [];
    let evidence: string[] = [];
    let opCats: string[] = [];
    try {
      findings = JSON.parse(r.findingsJson) as Finding[];
      evidence = (JSON.parse(r.operatorEvidence ?? '[]') as string[]).filter((s) => s.trim());
      opCats = r.operatorCategories ? (JSON.parse(r.operatorCategories) as string[]) : [];
    } catch {
      continue;
    }
    if (evidence.length === 0 || hasNonStudentFinding(findings)) continue;
    const student = findings.filter((f) => f.source === 'student');
    // 운영자가 지목한 유형이 우선, 없으면 학생 소견의 유형 — 내장 유형만 (커스텀 라벨은 제외)
    const raw = opCats.length ? opCats : student.map((f) => f.category);
    const categories = [...new Set(raw)].filter((c): c is RiskCategory => (RISK_CATEGORIES as readonly string[]).includes(c));
    if (categories.length === 0) continue;
    out.push({ categories, detected: student.length > 0, evidence, reportId: r.reportId, createdAt: r.createdAt });
  }
  return out;
}

export interface ArgosCategoryCount {
  category: RiskCategory;
  cases: number;
  detected: number;
  missed: number;
  sentences: number;
}

/** 화면의 유형 목록 — 확정 건이 있는 유형만, 건수 많은 순 */
export async function getArgosCategoryCounts(prisma: PrismaClient): Promise<ArgosCategoryCount[]> {
  const agg = new Map<RiskCategory, ArgosCategoryCount>();
  for (const c of await collectArgosCases(prisma)) {
    for (const cat of c.categories) {
      const cur = agg.get(cat) ?? { category: cat, cases: 0, detected: 0, missed: 0, sentences: 0 };
      cur.cases++;
      if (c.detected) cur.detected++;
      else cur.missed++;
      cur.sentences += c.evidence.length;
      agg.set(cat, cur);
    }
  }
  // **ARGOS 미탐(코드가 받쳐줄 확정 위반) 많은 순** (13차 검토 A, 2026-09-03) — 본선의 신호는
  // "ARGOS 가 놓친 확정 위반"이다. 문턱 컷은 두지 않는다(검토 Q4: 콜드스타트에선 근거 없는
  // 상수가 결정권을 갖는다) — 정렬로만 "어느 유형부터 볼지"를 준다. missed 동수면 확정 건 순
  return [...agg.values()].sort((a, b) => b.missed - a.missed || b.cases - a.cases);
}

/**
 * **졸업 강등 본선의 실행 통로** (Q1, 2026-09-01 창업자 확정) — ARGOS 유형별 모음을 보고
 * "이 variation 들을 학습 표현으로 내리자"고 정한 것을 여기서 등록한다.
 *
 * 사전 등록은 **출처가 있어야 한다**(반려·철회 건에 붙여서만) — 그 원칙을 지키려고,
 * 임의 등록이 아니라 **그 유형의 가장 최근 확정 ARGOS 건 reportId 를 자동으로 물린다.**
 * 그 유형에 확정 건이 하나도 없으면(= 근거 없음) 등록을 거부한다.
 *
 * 검증(2어절·4자·중복)·5층 자격·재검수는 createLearnedPhrase 가 그대로 한다 — 반려 흐름의
 * 등록과 **같은 함수**라 두 경로가 갈라지지 않는다.
 */
export async function registerPhraseFromArgos(
  prisma: PrismaClient,
  input: { category: string; phrase: string; operatorUserId: string; note?: string | null },
) {
  if (!(RISK_CATEGORIES as readonly string[]).includes(input.category)) {
    throw new ItemPackError('알 수 없는 유형입니다');
  }
  const phrase = input.phrase.trim();
  const issues = validatePhrase(phrase);
  if (issues.length > 0) throw new ItemPackError(issues.join(' / '));

  // 출처 = 그 유형의 가장 최근 확정 ARGOS 건 (collectArgosCases 는 createdAt desc)
  const source = (await collectArgosCases(prisma)).find((c) => c.categories.includes(input.category as RiskCategory));
  if (!source) {
    throw new ItemPackError(
      '이 유형에는 근거가 된 확정 건이 없습니다 — 출처 없이 사전에 등록할 수 없습니다. ' +
        'ARGOS 만 잡은 건을 반려하며 근거 문장을 짚으면 여기서 등록할 수 있습니다.',
    );
  }
  return createLearnedPhrase(prisma, {
    phrase,
    category: input.category as RiskCategory,
    note: input.note ?? null,
    createdBy: input.operatorUserId,
    sourceReportId: source.reportId,
  });
}

async function buildArgosCategoryPack(prisma: PrismaClient, category: string) {
  if (!(RISK_CATEGORIES as readonly string[]).includes(category)) throw new ItemPackError('알 수 없는 유형입니다');
  const cat = category as RiskCategory;
  const cases = (await collectArgosCases(prisma)).filter((c) => c.categories.includes(cat));
  const evidence: ItemEvidenceLine[] = cases.flatMap((c) =>
    c.evidence.map((sentence) => ({
      sentence,
      // 층 칸에 "잡았나/놓쳤나"를 싣는다 — 문장을 읽을 때 ARGOS 의 현재 능력이 함께 보인다
      layer: c.detected ? 'ARGOS 검출' : 'ARGOS 미탐',
      verdict: 'TP' as const,
      createdAt: c.createdAt,
    })),
  );
  const detected = cases.filter((c) => c.detected).length;
  return assembleItemTeacherPack({
    itemId: `${ARGOS_ITEM_PREFIX}${cat}`,
    label: RISK_CATEGORY_LABEL[cat],
    layer: 'ARGOS_CATEGORY',
    category: cat,
    stats: { matched: cases.length, truePos: cases.length, falsePos: 0, argosDetected: detected, argosMissed: cases.length - detected },
    evidence,
  });
}

export async function buildItemTeacherPack(
  prisma: PrismaClient,
  itemId: string,
): Promise<{ title: string; text: string; count: number }> {
  if (itemId.startsWith(ARGOS_ITEM_PREFIX)) return buildArgosCategoryPack(prisma, itemId.slice(ARGOS_ITEM_PREFIX.length));
  const ladder = await getDetectionLadder(prisma);
  const row = ladder.find((r) => r.id === itemId);
  if (!row) throw new ItemPackError('검출 항목을 찾을 수 없습니다');
  if (row.layer !== 'PHRASE' && row.layer !== 'RULE_WARN') {
    // BLOCK 은 사람 판정이 안 붙고(즉시거절) ARGOS 는 항목 단위가 아니다 — 대상 밖
    throw new ItemPackError('항목 질문지는 학습표현·규칙 WARN 만 만듭니다');
  }
  const layer: ItemPackLayer = row.layer;
  const stats = {
    matched: row.matched,
    truePos: row.truePos,
    falsePos: row.falsePos,
    ageDays: row.ageDays,
    distinctResearchers: row.distinctResearchers,
    negationHits: row.negationHits,
    distinctSurfaces: row.distinctSurfaces,
    topSurfaceShare: row.topSurfaceShare,
    recommendation: row.recommendation
      ? `${row.recommendation.kind} — ${row.recommendation.reason}`
      : null,
  };

  if (layer === 'PHRASE') {
    const phraseId = itemId.replace(/^learned:/, '');
    const [phrase, hits] = await Promise.all([
      prisma.learnedPhrase.findUnique({ where: { id: phraseId }, select: { category: true } }),
      prisma.learnedPhraseHit.findMany({
        where: { phraseId },
        orderBy: { createdAt: 'desc' },
        select: {
          reportId: true,
          matchedSentence: true,
          matchedSurface: true,
          negation: true,
          verdict: true,
          createdAt: true,
        },
      }),
    ]);
    // 승인을 오탐/경미로 가르는 값은 검수 기록에만 있다 — 리포트별 최신 판정 기록을 맞춘다
    const reportIds = [...new Set(hits.map((h) => h.reportId))];
    const reviews = reportIds.length
      ? await prisma.complianceReview.findMany({
          where: { reportId: { in: reportIds }, operatorVerdict: { not: null } },
          orderBy: { createdAt: 'desc' },
          select: { reportId: true, operatorVerdict: true, aiFindingsValid: true },
        })
      : [];
    const latestByReport = new Map<string, { operatorVerdict: string | null; aiFindingsValid: boolean | null }>();
    for (const r of reviews) if (!latestByReport.has(r.reportId)) latestByReport.set(r.reportId, r);

    const evidence: ItemEvidenceLine[] = hits.map((h) => {
      const rv = latestByReport.get(h.reportId);
      return {
        sentence: h.matchedSentence,
        surface: h.matchedSurface,
        negation: h.negation,
        // hit.verdict 가 판정 방향, aiFindingsValid 가 승인의 갈래 — 기록이 없으면 hit 값만으로
        verdict: classifyItemVerdict(rv?.operatorVerdict ?? h.verdict, rv?.aiFindingsValid),
        createdAt: h.createdAt,
      };
    });
    // **질문지를 뽑았다는 도장** (2026-09-01 창업자 확정) — 졸업 관문이 이 값을 본다.
    // 사건별 질문지의 teacherAskedAt 과 같은 원리: 묻지 않고 내리는 것을 구조로 막는다
    await prisma.learnedPhrase.update({ where: { id: phraseId }, data: { itemPackAskedAt: new Date() } });
    return assembleItemTeacherPack({
      itemId,
      label: row.label,
      layer,
      category: (phrase?.category as RiskCategory | undefined) ?? null,
      stats,
      evidence,
    });
  }

  // 규칙 WARN — 소견에서 이 규칙 id 의 것만 골라 문맥·층을 싣는다.
  // **리포트당 기록 하나만** 쓴다 (실측 2026-09-01: 같은 리포트가 재제출·카나리아로 여러 번
  // 검수돼 같은 문장이 "판정 전"으로 5번 반복됐다). 판정이 붙은 기록이 있으면 그것, 없으면 최신
  const all = await prisma.complianceReview.findMany({
    where: { findingsJson: { contains: `"${itemId}"` } },
    orderBy: { createdAt: 'desc' },
    select: { reportId: true, findingsJson: true, operatorVerdict: true, aiFindingsValid: true, createdAt: true },
  });
  const perReport = new Map<string, (typeof all)[number]>();
  for (const r of all) {
    const cur = perReport.get(r.reportId);
    if (!cur || (!cur.operatorVerdict && r.operatorVerdict)) perReport.set(r.reportId, r);
  }
  const reviews = [...perReport.values()];
  const evidence: ItemEvidenceLine[] = [];
  let category: RiskCategory | null = null;
  let reason: string | null = null;
  for (const r of reviews) {
    let findings: Finding[] = [];
    try {
      findings = JSON.parse(r.findingsJson) as Finding[];
    } catch {
      continue;
    }
    const verdict = classifyItemVerdict(r.operatorVerdict, r.aiFindingsValid);
    for (const f of findings) {
      if (f.ruleId !== itemId) continue;
      category ??= f.category;
      reason ??= f.reason;
      // surface 는 2026-09-01 이후 소견에만 있다 — 그 전 기록은 출현형 요약에서 빠진다(복원 불가)
      evidence.push({ sentence: f.quote || null, surface: f.surface ?? null, layer: f.layer ?? null, verdict, createdAt: r.createdAt });
    }
  }
  return assembleItemTeacherPack({ itemId, label: row.label, layer, category, reason, stats, evidence });
}
