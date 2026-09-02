import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { getDetectionLadder } from '../detectionLadderService';
import { getGraduationWatch } from '../phraseGraduationService';

// 사다리 집계의 **배선** 시험 (2026-09-02) — 문턱·정책은 domain/__tests__/detectionLadder.test.ts
// 가 이미 고정한다. 여기서 붙잡는 것은 서비스가 DB 를 도메인 통계로 접는 길이다:
// 그림자 폴백·판정 조인처럼 **끊겨도 예외가 안 나는 배선**은 시험이 없으면 조용히
// 죽는다 — 폴백이 지워지면 졸업이 영영 안 뜨고, 조인이 어긋나면 복귀 추천이 유령
// 숫자로 뜬다. 둘 다 화면만 봐서는 "표본이 아직 없나 보다"로 읽힌다.

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createTestDb('ladder-wiring-');
});
afterAll(async () => {
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const NOW = new Date('2026-09-02T03:00:00Z');

let seq = 0;
async function makeReview(opts: {
  findings: unknown[];
  verdict?: string | null;
  aiFindingsValid?: boolean | null;
}) {
  const user = await prisma.user.create({
    data: { email: `ladder${seq++}@t.io`, identityVerified: true },
  });
  const res = await prisma.researcherProfile.create({ data: { userId: user.id } });
  const report = await prisma.report.create({
    data: {
      researcherId: res.id,
      title: 't',
      summary: 's',
      content: 'c',
      priceKrw: 1000,
      feeRateBp: 2000,
      status: 'PENDING_REVIEW',
    },
  });
  return prisma.complianceReview.create({
    data: {
      reportId: report.id,
      decision: 'WARN',
      reviewer: 'rule',
      findingsJson: JSON.stringify(opts.findings),
      needsOperatorReview: true,
      operatorVerdict: opts.verdict === undefined ? 'REJECTED' : opts.verdict,
      aiFindingsValid: opts.aiFindingsValid ?? null,
    },
  });
}

function learnedFinding(phraseId: string, category = 'PROFIT_GUARANTEE') {
  return {
    category,
    severity: 'WARN',
    quote: 'q',
    reason: 'r',
    source: 'learned',
    ruleId: `learned:${phraseId}`,
    phraseId,
  };
}
function studentFinding(category = 'PROFIT_GUARANTEE') {
  return { category, severity: 'WARN', quote: '', reason: 'r', source: 'student' };
}

async function makePhrase(phrase: string, over: { active?: boolean; graduatedAt?: Date } = {}) {
  const op = await prisma.user.create({
    data: { email: `ladder-op${seq++}@t.io`, identityVerified: true, role: 'OPERATOR' },
  });
  return prisma.learnedPhrase.create({
    data: {
      phrase,
      normalized: phrase.replace(/\s/g, ''),
      category: 'PROFIT_GUARANTEE',
      createdBy: op.id,
      active: over.active ?? true,
      graduatedAt: over.graduatedAt ?? null,
    },
  });
}

async function ladderRow(id: string) {
  const rows = await getDetectionLadder(prisma, NOW);
  return rows.find((r) => r.id === id);
}

describe('사전 행의 동반 검출 집계 — 졸업(중복 실증)의 재료', () => {
  it('라이브 학생 소견이 같은 건·같은 유형에 있으면 동반으로 센다', async () => {
    const p = await makePhrase('라이브 동반 표현');
    await makeReview({ findings: [learnedFinding(p.id), studentFinding()] });
    const row = await ladderRow(`learned:${p.id}`);
    expect(row?.studentCoDetected).toBe(1);
    expect(row?.studentMissed).toBe(0);
  });

  it('**그림자 폴백** — 본 기록에 학생 소견이 없어도 그림자 표에 있으면 동반이다', async () => {
    // 이 배선이 끊기면(그림자 조회 삭제) 그림자 시절의 모든 동반이 미동반으로 세져
    // 졸업이 영영 불가능해진다 — 예외가 안 나는 고장이라 이 시험이 유일한 감시자다
    const p = await makePhrase('그림자 동반 표현');
    const review = await makeReview({ findings: [learnedFinding(p.id)] });
    await prisma.shadowComplianceReview.create({
      data: {
        complianceReviewId: review.id,
        reviewer: 'student:test@t0.5/L7',
        findingsJson: JSON.stringify([studentFinding()]),
      },
    });
    const row = await ladderRow(`learned:${p.id}`);
    expect(row?.studentCoDetected).toBe(1);
    expect(row?.studentMissed).toBe(0);
  });

  it('학생 기록이 전무하면 미동반이다 — 모르면 내리지 않는다 (보수 방향)', async () => {
    const p = await makePhrase('기록 없음 표현');
    await makeReview({ findings: [learnedFinding(p.id)] });
    const row = await ladderRow(`learned:${p.id}`);
    expect(row?.studentCoDetected).toBe(0);
    expect(row?.studentMissed).toBe(1);
  });

  it('유형이 다르면 동반이 아니다 — "같은 건에서 뭔가 냈다"로는 하중 인수의 증거가 안 된다', async () => {
    const p = await makePhrase('유형 불일치 표현');
    await makeReview({
      findings: [learnedFinding(p.id, 'PROFIT_GUARANTEE'), studentFinding('SOLICIT_CONTACT')],
    });
    const row = await ladderRow(`learned:${p.id}`);
    expect(row?.studentCoDetected).toBe(0);
    expect(row?.studentMissed).toBe(1);
  });
});

describe('IRIS 행(졸업 관찰)의 판정 조인 — 복귀(구멍 실증)의 트리거', () => {
  async function watchHit(
    phraseId: string,
    complianceReviewId: string,
    over: { studentFlagged?: boolean; matchedSurface?: string } = {},
  ) {
    return prisma.graduationWatchHit.create({
      data: {
        phraseId,
        complianceReviewId,
        category: 'PROFIT_GUARANTEE',
        studentFlagged: over.studentFlagged ?? false,
        matchedSurface: over.matchedSurface ?? '표면형',
      },
    });
  }

  it('미탐 ∩ 확정 위반 ≥2 · 그림자 오탐 0 → missTruePos 가 서고 복귀 추천이 뜬다', async () => {
    const g = await makePhrase('복귀 실증 표현', {
      active: false,
      graduatedAt: new Date(NOW.getTime() - 1 * DAY),
    });
    const r1 = await makeReview({ findings: [] }); // REJECTED = 확정 위반
    const r2 = await makeReview({ findings: [] });
    const r3 = await makeReview({ findings: [], verdict: null }); // 아직 판정 없음
    await watchHit(g.id, r1.id); // 미탐 + 확정 → missTruePos
    await watchHit(g.id, r2.id); // 미탐 + 확정 → missTruePos
    await watchHit(g.id, r3.id); // 미탐인데 판정 없음 → missTruePos 제외 (미탐 총수에만)
    await watchHit(g.id, r1.id, { studentFlagged: true }); // IRIS 도 잡음 → 미탐 아님
    // ⚠ 같은 phraseId+review 라도 category 가 같으면 recordGraduationWatch 는 한 행만
    // 남기지만, 여기서는 조인 산수를 재려고 행을 직접 심는다 (배선 시험의 특권)

    const row = await ladderRow(`learned:${g.id}`);
    expect(row?.layer).toBe('IRIS');
    expect(row?.studentMissCount).toBe(3); // 미탐 총수 — 판정 없는 건 포함 (재학습 신호)
    expect(row?.missTruePos).toBe(2); // 확정 위반만 — 복귀 트리거
    expect(row?.falsePos).toBe(0);
    expect(row?.recommendation?.kind).toBe('UNGRADUATE');

    // 관찰 상자(getGraduationWatch)도 **같은 수**를 내야 한다 — 두 화면이 같은 실증을
    // 다른 숫자로 말하면 운영자는 어느 쪽도 믿을 수 없다 (6+7 구현의 계약)
    const watch = await getGraduationWatch(prisma, NOW);
    const mine = watch.find((w) => w.id === g.id);
    expect(mine?.studentMissCount).toBe(3);
    expect(mine?.missTruePos).toBe(2);
    expect(mine?.shadowFalsePos).toBe(0);
  });

  it('그림자 오탐이 하나라도 있으면 복귀 추천이 죽는다 — 되살리면 정상 글을 잡는다', async () => {
    const g = await makePhrase('오탐 낀 표현', {
      active: false,
      graduatedAt: new Date(NOW.getTime() - 1 * DAY),
    });
    const tp1 = await makeReview({ findings: [] });
    const tp2 = await makeReview({ findings: [] });
    const fp = await makeReview({ findings: [], verdict: 'APPROVED', aiFindingsValid: false });
    await watchHit(g.id, tp1.id);
    await watchHit(g.id, tp2.id);
    await watchHit(g.id, fp.id, { studentFlagged: true }); // 그림자가 잡았는데 사람은 "오탐 승인"

    const row = await ladderRow(`learned:${g.id}`);
    expect(row?.missTruePos).toBe(2); // 실증 자체는 문턱에 닿았지만
    expect(row?.falsePos).toBe(1); // 오탐 1이
    expect(row?.recommendation).toBeNull(); // 추천을 죽인다

    const mine = (await getGraduationWatch(prisma, NOW)).find((w) => w.id === g.id);
    expect(mine?.shadowFalsePos).toBe(1);
  });

  it('관찰 창(7일) 밖의 졸업 표현은 IRIS 행으로 뜨지 않는다 — 얼어붙은 수로 영구 낙인 금지', async () => {
    const g = await makePhrase('창 밖 표현', {
      active: false,
      graduatedAt: new Date(NOW.getTime() - 8 * DAY),
    });
    const r = await makeReview({ findings: [] });
    await watchHit(g.id, r.id);
    expect(await ladderRow(`learned:${g.id}`)).toBeUndefined();
  });
});
