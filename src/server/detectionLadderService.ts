import type { PrismaClient } from '@prisma/client';
import { RULE_SEVERITY_BY_ID, type Finding } from '@/domain/compliance';
import {
  recommendMigration,
  type DetectionItemStats,
  type DetectionLayer,
  type LadderRecommendation,
} from '@/domain/detectionLadder';

// 검출 항목 관리 — 승격/강등 사다리 대시보드의 **집계**.
//
// 쌓인 증거(운영자 판정)를 읽어 항목별 성적으로 접고, 도메인 로직에 넘겨 추천을 붙인다.
// **읽기 전용** — 실행은 사람. 데이터는 운영 판정이 쌓여야 차므로, 출시 전에는 대부분 빈다.

export interface DetectionLadderRow extends DetectionItemStats {
  recommendation: LadderRecommendation | null;
}

const DAY = 86_400_000;

export async function getDetectionLadder(
  prisma: PrismaClient,
  now = new Date(),
): Promise<DetectionLadderRow[]> {
  // 1) 판정된 검수 건에서 항목(ruleId)별 성적 — findingsJson × verdict (새 스키마 불요, 회신 25호 Q-C)
  const reviews = await prisma.complianceReview.findMany({
    where: { operatorVerdict: { not: null } },
    select: { findingsJson: true, operatorVerdict: true, aiFindingsValid: true, createdAt: true },
  });
  const perItem = new Map<
    string,
    { matched: number; truePos: number; falsePos: number; firstSeen: Date }
  >();
  for (const r of reviews) {
    let findings: Finding[] = [];
    try {
      findings = JSON.parse(r.findingsJson) as Finding[];
    } catch {
      continue;
    }
    const ids = new Set<string>();
    for (const f of findings) if (f.ruleId) ids.add(f.ruleId);
    if (ids.size === 0) continue;
    // 정탐 = 반려·철회로 확정 / 오탐 = "오탐"으로 명시 승인 (강등의 이유)
    const isTP = r.operatorVerdict === 'REJECTED' || r.operatorVerdict === 'TAKEDOWN';
    const isFP = r.operatorVerdict === 'APPROVED' && r.aiFindingsValid === false;
    for (const id of ids) {
      const cur = perItem.get(id) ?? { matched: 0, truePos: 0, falsePos: 0, firstSeen: r.createdAt };
      cur.matched++;
      if (isTP) cur.truePos++;
      if (isFP) cur.falsePos++;
      if (r.createdAt < cur.firstSeen) cur.firstSeen = r.createdAt;
      perItem.set(id, cur);
    }
  }

  // 2) 학습표현 메타 + hit 집계 (형태 안정성·리서처·부정 — 5조건과 판별자)
  const [phrases, hits] = await Promise.all([
    prisma.learnedPhrase.findMany({
      where: { active: true },
      select: { id: true, phrase: true, createdAt: true },
    }),
    prisma.learnedPhraseHit.findMany({
      select: { phraseId: true, matchedSurface: true, researcherId: true, negation: true },
    }),
  ]);
  const hitAgg = new Map<
    string,
    { surfaces: Map<string, number>; researchers: Set<string>; negation: number }
  >();
  for (const h of hits) {
    const agg = hitAgg.get(h.phraseId) ?? {
      surfaces: new Map<string, number>(),
      researchers: new Set<string>(),
      negation: 0,
    };
    if (h.matchedSurface) agg.surfaces.set(h.matchedSurface, (agg.surfaces.get(h.matchedSurface) ?? 0) + 1);
    if (h.researcherId) agg.researchers.add(h.researcherId);
    if (h.negation) agg.negation += 1;
    hitAgg.set(h.phraseId, agg);
  }

  const rows: DetectionLadderRow[] = [];

  // 학습표현 행
  for (const p of phrases) {
    const perf = perItem.get(`learned:${p.id}`) ?? { matched: 0, truePos: 0, falsePos: 0 };
    const agg = hitAgg.get(p.id);
    const surfaces = agg?.surfaces ?? new Map<string, number>();
    const surfaceTotal = [...surfaces.values()].reduce((a, b) => a + b, 0);
    const topSurface = surfaces.size > 0 ? Math.max(...surfaces.values()) : 0;
    const stats: DetectionItemStats = {
      id: `learned:${p.id}`,
      label: p.phrase,
      layer: 'PHRASE',
      matched: perf.matched,
      truePos: perf.truePos,
      falsePos: perf.falsePos,
      ageDays: Math.floor((now.getTime() - p.createdAt.getTime()) / DAY),
      distinctResearchers: agg?.researchers.size ?? 0,
      negationHits: agg?.negation ?? 0,
      distinctSurfaces: surfaces.size,
      topSurfaceShare: surfaceTotal > 0 ? topSurface / surfaceTotal : 0,
    };
    rows.push({ ...stats, recommendation: recommendMigration(stats) });
  }

  // 코드 규칙 행 — perItem 중 learned: 아닌 것 (ruleId 가 곧 라벨)
  for (const [id, perf] of perItem) {
    if (id.startsWith('learned:')) continue;
    const severity = RULE_SEVERITY_BY_ID[id];
    const layer: DetectionLayer = severity === 'BLOCK' ? 'RULE_BLOCK' : 'RULE_WARN';
    const stats: DetectionItemStats = {
      id,
      label: id,
      layer,
      matched: perf.matched,
      truePos: perf.truePos,
      falsePos: perf.falsePos,
      // 규칙은 등록일이 없어 첫 감지 검수일로 관찰 기간을 잰다
      ageDays: Math.floor((now.getTime() - perf.firstSeen.getTime()) / DAY),
    };
    rows.push({ ...stats, recommendation: recommendMigration(stats) });
  }

  // 추천 있는 항목을 위로, 그 안에서 걸림 많은 순
  rows.sort((a, b) => {
    const ra = a.recommendation ? 1 : 0;
    const rb = b.recommendation ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return b.matched - a.matched;
  });
  return rows;
}
