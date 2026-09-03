import type { PrismaClient } from '@prisma/client';
import { RULE_SEVERITY_BY_ID, type Finding } from '@/domain/compliance';
import {
  LADDER_THRESHOLDS,
  LADDER_THRESHOLDS_COLDSTART,
  recommendMigration,
  type DetectionItemStats,
  type DetectionLayer,
  type LadderRecommendation,
} from '@/domain/detectionLadder';
import { GRADUATION_WATCH_DAYS } from './phraseGraduationService';
import { getLadderColdstart } from './appSettings';

// 검출 항목 관리 — 승격/강등 사다리 대시보드의 **집계**.
//
// 쌓인 증거(운영자 판정)를 읽어 항목별 성적으로 접고, 도메인 로직에 넘겨 추천을 붙인다.
// **읽기 전용** — 실행은 사람. 데이터는 운영 판정이 쌓여야 차므로, 출시 전에는 대부분 빈다.

export interface DetectionLadderRow extends DetectionItemStats {
  recommendation: LadderRecommendation | null;
}

const DAY = 86_400_000;

/**
 * 규칙 소견의 출현형 빈도 → 형태 안정 판별자 (C-2). 표본이 0 이면 아무것도 싣지 않는다 —
 * 도메인은 `surfaceSamples` 미달을 "모름"으로 보고 BLOCK 자격에서 형태 조건을 뺀다
 */
function ruleSurfaceStats(surfaces: Map<string, number>): Partial<DetectionItemStats> {
  const total = [...surfaces.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return {};
  const top = Math.max(...surfaces.values());
  return { surfaceSamples: total, distinctSurfaces: surfaces.size, topSurfaceShare: top / total };
}

export async function getDetectionLadder(
  prisma: PrismaClient,
  now = new Date(),
): Promise<DetectionLadderRow[]> {
  // 문턱 프로필 (C-7) — 콜드스타트 스위치가 켜져 있으면 절대 건수 대신 꼬리 연속 정탐으로 본다
  const thresholds = (await getLadderColdstart(prisma)) ? LADDER_THRESHOLDS_COLDSTART : LADDER_THRESHOLDS;
  // 1) 판정된 검수 건에서 항목(ruleId)별 성적 — findingsJson × verdict (새 스키마 불요, 회신 25호 Q-C)
  const reviews = await prisma.complianceReview.findMany({
    where: { operatorVerdict: { not: null } },
    // 시간순 — 꼬리 연속 정탐(C-7)은 순서가 있어야 센다
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      findingsJson: true,
      operatorVerdict: true,
      aiFindingsValid: true,
      createdAt: true,
    },
  });
  const perItem = new Map<
    string,
    {
      matched: number;
      truePos: number;
      falsePos: number;
      minorPos: number;
      firstSeen: Date;
      /** 규칙 소견의 출현형 빈도 (C-2) — 2026-09-01 이후 소견만 값이 있다 */
      surfaces: Map<string, number>;
      /** 꼬리 연속 정탐 (C-7) — 오탐·경미를 만나면 0 */
      streak: number;
    }
  >();
  // 사전 항목의 **IRIS 동반 검출** 재료 (졸업의 실증 — 2026-08-31): 사전 소견이 걸린
  // 확정 건마다 "같은 건에서 학생도 같은 유형을 냈는가"를 대조해야 한다. 학생이 그림자
  // 모드였던 건은 소견이 본 기록에 없어 그림자 표를 나중에 배치로 대조한다.
  const phraseHitRows: Array<{ reviewId: string; phraseRuleId: string; category: string }> = [];
  const studentCatsByReview = new Map<string, Set<string>>();
  for (const r of reviews) {
    let findings: Finding[] = [];
    try {
      findings = JSON.parse(r.findingsJson) as Finding[];
    } catch {
      continue;
    }
    const ids = new Set<string>();
    // 규칙 소견의 출현형 (C-2) — 항목별로 모아 형태 안정을 잰다. surface 는 2026-09-01 부터
    const surfacesThisReview = new Map<string, string[]>();
    for (const f of findings) {
      if (f.ruleId) ids.add(f.ruleId);
      if (f.ruleId && f.surface) {
        surfacesThisReview.set(f.ruleId, [...(surfacesThisReview.get(f.ruleId) ?? []), f.surface]);
      }
      if (f.source === 'student') {
        const set = studentCatsByReview.get(r.id) ?? new Set<string>();
        set.add(f.category);
        studentCatsByReview.set(r.id, set);
      }
      if (f.ruleId?.startsWith('learned:')) {
        phraseHitRows.push({ reviewId: r.id, phraseRuleId: f.ruleId, category: f.category });
      }
    }
    if (ids.size === 0) continue;
    // 정탐 = 반려·철회로 확정 / 오탐 = "오탐"으로 명시 승인 (위임의 이유)
    const isTP = r.operatorVerdict === 'REJECTED' || r.operatorVerdict === 'TAKEDOWN';
    const isFP = r.operatorVerdict === 'APPROVED' && r.aiFindingsValid === false;
    // 경미 = 승인 + "지적은 타당" (C-5) — 오탐이 아니지만 승격 자격의 비율 상한에 들어간다
    const isMinor = r.operatorVerdict === 'APPROVED' && r.aiFindingsValid === true;
    for (const id of ids) {
      const cur = perItem.get(id) ?? {
        matched: 0,
        truePos: 0,
        falsePos: 0,
        minorPos: 0,
        firstSeen: r.createdAt,
        surfaces: new Map<string, number>(),
        streak: 0,
      };
      cur.matched++;
      if (isTP) cur.truePos++;
      if (isFP) cur.falsePos++;
      if (isMinor) cur.minorPos++;
      // 꼬리 연속 정탐 (C-7): 정탐이면 잇고, 오탐·경미면 끊는다. KEPT(신고 기각)·MISSED 는
      // 이 항목의 판단이 아니라 중립 — 잇지도 끊지도 않는다
      if (isTP) cur.streak++;
      else if (isFP || isMinor) cur.streak = 0;
      for (const sf of surfacesThisReview.get(id) ?? []) cur.surfaces.set(sf, (cur.surfaces.get(sf) ?? 0) + 1);
      if (r.createdAt < cur.firstSeen) cur.firstSeen = r.createdAt;
      perItem.set(id, cur);
    }
  }

  // 학생이 그림자 모드였던 건의 유형 보충 — recordGraduationWatch 와 같은 폴백 규칙.
  // 본 기록에 학생 소견이 없다고 "안 잡았다"로 단정하면, 그림자 시절의 동반 검출이
  // 전부 미동반으로 세져 졸업이 영영 불가능해진다
  const needShadow = [
    ...new Set(
      phraseHitRows.filter((h) => !studentCatsByReview.has(h.reviewId)).map((h) => h.reviewId),
    ),
  ];
  if (needShadow.length > 0) {
    const shadows = await prisma.shadowComplianceReview.findMany({
      where: { complianceReviewId: { in: needShadow } },
      select: { complianceReviewId: true, findingsJson: true },
    });
    for (const sh of shadows) {
      try {
        const set = studentCatsByReview.get(sh.complianceReviewId) ?? new Set<string>();
        for (const f of JSON.parse(sh.findingsJson) as Finding[]) set.add(f.category);
        studentCatsByReview.set(sh.complianceReviewId, set);
      } catch {
        // 깨진 그림자 기록은 "학생 침묵"으로 남는다 — 미동반(보수 방향)
      }
    }
  }
  // 사전 항목별 동반/미동반 집계 — 알 수 없는 건(학생 기록 전무)은 미동반으로 센다
  // (모르면 내리지 않는다)
  const coAgg = new Map<string, { co: number; missed: number }>();
  for (const h of phraseHitRows) {
    const agg = coAgg.get(h.phraseRuleId) ?? { co: 0, missed: 0 };
    if (studentCatsByReview.get(h.reviewId)?.has(h.category)) agg.co++;
    else agg.missed++;
    coAgg.set(h.phraseRuleId, agg);
  }

  // 2) 학습표현 메타 + hit 집계 (형태 안정성·리서처·부정 — 5조건과 판별자)
  //    + 졸업 관찰 창 안의 졸업 표현 — IRIS 층 행이 되어 졸업 강등 추천의 재료가 된다
  const watchCutoff = new Date(now.getTime() - GRADUATION_WATCH_DAYS * DAY);
  const [phrases, hits, graduated] = await Promise.all([
    prisma.learnedPhrase.findMany({
      where: { active: true },
      select: { id: true, phrase: true, createdAt: true },
    }),
    prisma.learnedPhraseHit.findMany({
      select: { phraseId: true, matchedSurface: true, researcherId: true, negation: true },
    }),
    prisma.learnedPhrase.findMany({
      where: { active: false, graduatedAt: { gte: watchCutoff } },
      select: { id: true, phrase: true, createdAt: true, graduatedAt: true },
    }),
  ]);
  const watchHits =
    graduated.length > 0
      ? await prisma.graduationWatchHit.findMany({
          where: { phraseId: { in: graduated.map((p) => p.id) } },
          select: {
            phraseId: true,
            studentFlagged: true,
            matchedSurface: true,
            complianceReviewId: true,
          },
        })
      : [];
  // 그림자 재생의 **사람 판정 대조** — 관찰이 붙은 검수 건의 운영자 판정을 가져와
  // "그림자가 잡은 것이 맞는 것이었나(정탐)/정상 글이었나(오탐)"를 잰다.
  // 분류 기준은 perItem(1단계)과 **똑같이** 둔다 — 두 잣대가 갈라지면 사전 시절 성적과
  // 졸업 후 그림자 성적을 나란히 읽을 수 없다.
  const watchReviewIds = [...new Set(watchHits.map((h) => h.complianceReviewId))];
  const watchVerdicts = new Map<string, { tp: boolean; fp: boolean }>();
  if (watchReviewIds.length > 0) {
    const rs = await prisma.complianceReview.findMany({
      where: { id: { in: watchReviewIds } },
      select: { id: true, operatorVerdict: true, aiFindingsValid: true },
    });
    for (const r of rs) {
      watchVerdicts.set(r.id, {
        tp: r.operatorVerdict === 'REJECTED' || r.operatorVerdict === 'TAKEDOWN',
        fp: r.operatorVerdict === 'APPROVED' && r.aiFindingsValid === false,
      });
    }
  }
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
    const perf = perItem.get(`learned:${p.id}`) ?? { matched: 0, truePos: 0, falsePos: 0, minorPos: 0, streak: 0 };
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
      minorPos: perf.minorPos,
      tailTruePosStreak: perf.streak,
      ageDays: Math.floor((now.getTime() - p.createdAt.getTime()) / DAY),
      distinctResearchers: agg?.researchers.size ?? 0,
      negationHits: agg?.negation ?? 0,
      distinctSurfaces: surfaces.size,
      topSurfaceShare: surfaceTotal > 0 ? topSurface / surfaceTotal : 0,
      studentCoDetected: coAgg.get(`learned:${p.id}`)?.co ?? 0,
      studentMissed: coAgg.get(`learned:${p.id}`)?.missed ?? 0,
    };
    rows.push({ ...stats, recommendation: recommendMigration(stats, thresholds) });
  }

  // 졸업 표현 행 (IRIS 층) — 관찰 창(7일) 안에서만 잰다. 창이 닫히면 감시 기록이 더
  // 안 쌓여 수가 그대로 얼어붙는데, 그 얼어붙은 수로 언제까지나 추천하면 "한 번 본
  // 분포"가 영구 낙인이 된다. 창 밖의 미탐은 신고 경로(미탐 재활성화)가 잡는다.
  //
  // 표면형은 **졸업 후 관찰 기록**에서 센다 — 졸업 전 LearnedPhraseHit 의 표면형은
  // 졸업의 근거(형태 다양)였으므로 반대 방향(강등)의 증거로 쓰면 순환이 된다.
  // 강등의 증거는 졸업 후의 실측이어야 한다 (matchedSurface, 2026-08-31).
  //
  // 정탐/오탐은 **그림자 값**이다: 이 관찰들은 소견을 안 냈으므로(감시 전용) 운영자가
  // 이 표현 때문에 판정한 것이 아니라, "그림자가 잡은 그 문서를 사람이 어떻게 판정했나"
  // 를 사후 대조한 것이다. 이것이 졸업 강등 추천의 트리거가 된다(recommendMigration).
  for (const p of graduated) {
    const mine = watchHits.filter((h) => h.phraseId === p.id);
    const surfaces = new Map<string, number>();
    for (const h of mine) {
      if (h.matchedSurface) surfaces.set(h.matchedSurface, (surfaces.get(h.matchedSurface) ?? 0) + 1);
    }
    const surfaceTotal = [...surfaces.values()].reduce((a, b) => a + b, 0);
    const topSurface = surfaces.size > 0 ? Math.max(...surfaces.values()) : 0;
    const stats: DetectionItemStats = {
      id: `learned:${p.id}`,
      label: p.phrase,
      layer: 'IRIS',
      matched: mine.length, // 관찰 창에서 나타난 횟수 (소견은 안 냈다 — 감시 전용)
      truePos: mine.filter((h) => watchVerdicts.get(h.complianceReviewId)?.tp).length,
      falsePos: mine.filter((h) => watchVerdicts.get(h.complianceReviewId)?.fp).length,
      // 복귀의 실증 = 그림자 정탐 ∩ IRIS 미탐 — "IRIS 가 놓친 확정 위반을 옛 항목이 잡음"
      missTruePos: mine.filter(
        (h) => !h.studentFlagged && watchVerdicts.get(h.complianceReviewId)?.tp,
      ).length,
      ageDays: Math.floor((now.getTime() - p.createdAt.getTime()) / DAY),
      distinctSurfaces: surfaces.size,
      topSurfaceShare: surfaceTotal > 0 ? topSurface / surfaceTotal : 0,
      // 사유에 "어떤 형태들로 나타났는가"를 싣는다 — 빈도 상위 순
      surfaceExamples: [...surfaces.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([sfc]) => sfc),
      studentMissCount: mine.filter((h) => !h.studentFlagged).length,
    };
    rows.push({ ...stats, recommendation: recommendMigration(stats, thresholds) });
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
      minorPos: perf.minorPos,
      tailTruePosStreak: perf.streak,
      // 규칙의 형태 안정 (C-2) — 출현형 표본이 있을 때만 싣는다(없으면 도메인이 "모름"으로 본다)
      ...(ruleSurfaceStats(perf.surfaces)),
      // 규칙은 등록일이 없어 첫 감지 검수일로 관찰 기간을 잰다
      ageDays: Math.floor((now.getTime() - perf.firstSeen.getTime()) / DAY),
    };
    rows.push({ ...stats, recommendation: recommendMigration(stats, thresholds) });
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
