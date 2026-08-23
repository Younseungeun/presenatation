import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DECISION_SPEED_WINDOW_MS,
  ELAPSED_MEASURE_START,
  getApprovedElapsedCoverage,
} from '../decisionSpeedService';
import { createTestDb } from './helpers/testDb';

/**
 * **"시간이 없다"는 한 가지 사실이 아니다** (2026-08-24 창업자 지시).
 *
 * 판단 시간이 빈 승인은 두 갈래이고 처방이 정반대다:
 *   · 측정 도입 **전** 판정 → 잴 장치가 없었다. 고칠 것이 없고 창이 지나면 사라진다
 *   · 측정 도입 **후** 판정 → 큐 밖 경로로 승인이 들어왔다. **이쪽이 진짜 신호다**
 *
 * 예전에는 둘을 한 숫자로 세고, 이유는 화면이 **집계 창이 측정 시작일을 물고 있는가**
 * 로 짐작했다. 그건 창의 성질이지 그 건의 성질이 아니라서, 창이 걸쳐 있는 동안에는
 * 진짜 큐 밖 승인까지 전부 "측정 전"으로 덮였다 — 정확히 봐야 할 것만 가려졌다.
 */

let prisma: PrismaClient;

/** 창 안이면서 측정 도입 뒤 */
const AFTER = ELAPSED_MEASURE_START + 86_400_000;
/** 창 안이면서 측정 도입 전 */
const BEFORE = ELAPSED_MEASURE_START - 86_400_000;
/** 그 둘이 모두 창 안에 들어오도록 잡은 '지금' */
const NOW = new Date(AFTER + 86_400_000);

let seq = 0;
async function approval(reviewedAt: number, elapsedMs: number | null) {
  const id = `cr-${++seq}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ComplianceReview"
       ("id","reportId","decision","reviewer","findingsJson","needsOperatorReview","operatorVerdict","operatorReviewedAt","decisionElapsedMs","createdAt")
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    `rep-${seq}`,
    'WARN',
    'rule',
    '[]',
    0,
    'APPROVED',
    reviewedAt,
    elapsedMs,
    reviewedAt,
  );
}

beforeAll(async () => {
  prisma = createTestDb('decision-coverage-');
  /* **외래키를 끈다.** 재는 것은 `COUNT`/`SUM` 하나이고, 그 답은 리포트·리서처·유저가
     실재하는지와 무관하다. 그 사슬을 다 세우면 이 파일의 절반이 검수와 상관없는
     시드가 되고, 그러면 시험이 무엇을 지키는지 읽기 어려워진다.
     참조 무결성은 그것을 실제로 쓰는 시험들이 따로 지킨다 */
  await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('DELETE FROM "ComplianceReview"');
});

describe('빈 판단 시간을 사유별로 가른다', () => {
  it('측정 전 승인은 `beforeMeasureStart` — 결함이 아니라 나이다', async () => {
    await approval(BEFORE, null);
    await approval(BEFORE, null);
    const c = await getApprovedElapsedCoverage(prisma, NOW);
    expect(c).toMatchObject({ approvedTotal: 2, beforeMeasureStart: 2, offQueue: 0 });
  });

  it('측정 후인데 비어 있으면 `offQueue` — **이쪽이 봐야 할 것이다**', async () => {
    await approval(AFTER, null);
    const c = await getApprovedElapsedCoverage(prisma, NOW);
    expect(c).toMatchObject({ approvedTotal: 1, beforeMeasureStart: 0, offQueue: 1 });
  });

  it('**둘이 동시에 뜬다** — 예전 방식이 정확히 이걸 못 했다', async () => {
    await approval(BEFORE, null);
    await approval(BEFORE, null);
    await approval(AFTER, null); // 창이 측정 시작일을 물고 있어도 이 건은 덮이지 않는다
    const c = await getApprovedElapsedCoverage(prisma, NOW);
    expect(c).toMatchObject({ beforeMeasureStart: 2, offQueue: 1, approvedWithoutElapsed: 3 });
  });

  it('시간이 있는 건은 어느 쪽에도 안 센다', async () => {
    await approval(AFTER, 12_000);
    await approval(BEFORE, 9_000); // 소급 기입된 옛 건도 마찬가지
    const c = await getApprovedElapsedCoverage(prisma, NOW);
    expect(c).toMatchObject({ approvedTotal: 2, approvedWithoutElapsed: 0, offQueue: 0 });
  });

  it('합이 언제나 맞는다 — 셋이 따로 세어지면 화면이 그 어긋남을 못 본다', async () => {
    await approval(BEFORE, null);
    await approval(AFTER, null);
    await approval(AFTER, 5_000);
    const c = await getApprovedElapsedCoverage(prisma, NOW);
    expect(c.approvedWithoutElapsed).toBe(c.beforeMeasureStart + c.offQueue);
    expect(c.approvedWithoutElapsed).toBeLessThanOrEqual(c.approvedTotal);
  });
});

describe('창 밖과 승인 아닌 것은 보지 않는다', () => {
  it('창보다 오래된 승인은 안 센다', async () => {
    await approval(NOW.getTime() - DECISION_SPEED_WINDOW_MS - 1, null);
    const c = await getApprovedElapsedCoverage(prisma, NOW);
    expect(c.approvedTotal).toBe(0);
  });

  it('**승인만 센다** — 피로 필터가 걸리는 유일한 판정이라 여기서만 눈이 감긴다', async () => {
    const id = 'cr-rejected';
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ComplianceReview"
         ("id","reportId","decision","reviewer","findingsJson","needsOperatorReview","operatorVerdict","operatorReviewedAt","decisionElapsedMs","createdAt")
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id,
      'rep-rejected',
      'WARN',
      'rule',
      '[]',
      0,
      'REJECTED',
      AFTER,
      null,
      AFTER,
    );
    const c = await getApprovedElapsedCoverage(prisma, NOW);
    expect(c.approvedTotal).toBe(0);
  });
});
