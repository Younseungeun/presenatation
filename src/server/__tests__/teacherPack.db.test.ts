import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import { buildTeacherPack } from '../teacherPack';
import { teacherPackId } from '@/domain/teacherAnswer';
import { STUDENT_LABELS } from '@/domain/studentText';

// **질문지는 규정문이 약속한 것을 실제로 담아야 한다** (18차 V-2).
//
// ── 이 시험이 있는 이유 (2026-08-21 실제 결함) ───────────────────────
// 처음 구현은 `SYSTEM_PROMPT` 를 그대로 싣고 원문은 `buildStudentText` 로 따로 조립했다.
// 그 규정문은 사용자 메시지에 무엇이 들어 있는지를 **세 군데서 전제**하는데,
// 질문지에는 셋 다 없었다:
//
//   "무작위 경계(BOUNDARY)로 감싼 원문이 들어옵니다"        → 경계가 없었다
//   "거래소가 위험을 경고한 종목인데(사용자 메시지에 표시됨)" → 표시가 없었다
//   "표시된 구간 경계로 판정하세요"                          → 눈금이 없었다
//
// 고장 나지 않는 결함이다 — 질문지는 멀쩡해 보이고 교사도 답을 준다. 다만 교사는
// 있지도 않은 봉투를 찾고, MISSING_DISCLOSURE 를 **영원히 판정할 수 없고**, 크기를
// 규정문이 명시적으로 금지한 "감각"으로 판정한다. **조용한 무동작**이 또 한 번 났다.
//
// 그래서 값이 아니라 **약속과 내용의 일치**를 시험한다.

let prisma: PrismaClient;

async function seedReview(opts: { riskLevel?: string; magnitudePct?: number } = {}) {
  const user = await prisma.user.create({
    data: { email: `r${Math.random()}@t.io`, identityVerified: true },
  });
  const researcher = await prisma.researcherProfile.create({ data: { userId: user.id } });
  const report = await prisma.report.create({
    data: {
      researcherId: researcher.id,
      title: '삼성전자 하반기 전망',
      summary: '메모리 업황 회복을 근거로 봅니다',
      content: '공시와 업황 자료를 근거로 상승을 전망합니다.',
      priceKrw: 10_000,
      feeRateBp: 2_000,
      status: 'PENDING_REVIEW',
    },
  });
  if (opts.riskLevel) {
    await prisma.instrument.updateMany({
      where: { assetClass: 'KR_EQUITY', ticker: '005930' },
      data: { riskLevel: opts.riskLevel, riskNote: '투자경고 지정' },
    });
  }
  await prisma.predictionCard.create({
    data: {
      reportId: report.id,
      assetClass: 'KR_EQUITY',
      ticker: '005930',
      assetName: '삼성전자',
      direction: 'UP',
      targetType: 'RETURN_PCT',
      targetValue: opts.magnitudePct ?? 12,
      deadline: new Date(Date.now() + 90 * 86_400_000),
      confidence: 5,
    },
  });
  const review = await prisma.complianceReview.create({
    data: {
      reportId: report.id,
      decision: 'WARN',
      reviewer: 'rule',
      needsOperatorReview: true,
      findingsJson: JSON.stringify([
        { category: 'UNSUPPORTED_CLAIM', severity: 'WARN', quote: '반드시 오른다', reason: '근거 없음', source: 'rule' },
        { category: 'MISSING_DISCLOSURE', severity: 'WARN', quote: '위험 고지 없음', reason: '경고 종목', source: 'rule' },
      ]),
    },
  });
  return review.id;
}

beforeAll(async () => {
  prisma = createTestDb('teacher-pack-');
  await seedTestInstruments(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

const deps = { teacherTag: 'teacher-x', corrections: [] };

describe('규정문이 약속한 셋이 질문지에 있다 (18차 V-2)', () => {
  it('원문이 무작위 경계 안에 있고, 경계는 부를 때마다 다르다', async () => {
    const id = await seedReview();
    const a = await buildTeacherPack(prisma, id, deps);
    const b = await buildTeacherPack(prisma, id, deps);

    const boundary = a!.text.match(/BOUNDARY-([0-9a-f]{16})/)?.[1];
    expect(boundary, '경계가 없다 — 교사는 있지도 않은 봉투를 찾게 된다').toBeTruthy();
    expect(a!.text).toContain(`[본문 BOUNDARY-${boundary}]`);
    expect(a!.text).toContain(`[/본문 BOUNDARY-${boundary}]`);

    // 고정 경계면 리서처가 본문에 같은 값을 적어 구간을 빠져나갈 수 있다
    const other = b!.text.match(/BOUNDARY-([0-9a-f]{16})/)?.[1];
    expect(other).not.toBe(boundary);
  });

  it('위험 경고 종목이면 그 사실이 실린다 — 없으면 MISSING_DISCLOSURE 판정이 불가능하다', async () => {
    const id = await seedReview({ riskLevel: 'WARNING' });
    const pack = await buildTeacherPack(prisma, id, deps);
    expect(pack!.text).toMatch(/거래소가.*지정했습니다/);
  });

  it('크기 판정 눈금이 실린다 — 없으면 규정문이 금지한 "감각"으로 판정하게 된다', async () => {
    const id = await seedReview({ magnitudePct: 12 });
    const pack = await buildTeacherPack(prisma, id, deps);
    expect(pack!.text).toContain('크기 판정 눈금');
  });
});

describe('질문지의 나머지 약속', () => {
  it('맥락 문구가 **맨 앞**에 있다 — 축적 기준은 따르되 앞 건 오염만 막는다 (2026-08-26)', async () => {
    const id = await seedReview();
    const pack = await buildTeacherPack(prisma, id, deps);
    const at = pack!.text.indexOf('과거의 판정 기준은 따르되');
    expect(at).toBeGreaterThanOrEqual(0);
    // 본문 제목보다 뒤에 있으면 앞 건의 결론이 이미 적용된 채로 읽힌다
    expect(at).toBeLessThan(pack!.text.indexOf('검수 판정 비교'));
    // **축적된 기준을 버리라고 말하지 않는다** — 규정·교정 사례는 따르라고 명시해야 한다
    expect(pack!.text).toContain('그대로 근거로 삼으세요');
  });

  it('무결성 머리글의 마지막 낱말이 실제 끝과 맞는다 (18차 V-2)', async () => {
    const id = await seedReview();
    const pack = await buildTeacherPack(prisma, id, deps);
    const claimed = pack!.text.match(/마지막 낱말: "(.+)"/)?.[1];
    expect(claimed).toBeTruthy();
    const words = pack!.text.trim().split(/\s+/);
    expect(words[words.length - 1]).toBe(claimed);
  });

  it('답할 수 없는 유형은 **읽기 전용 문맥**으로 갈라 싣는다 (18차 V-1)', async () => {
    const id = await seedReview();
    const pack = await buildTeacherPack(prisma, id, deps);
    // 감추면 교사가 왜 보류됐는지 몰라 없는 위반을 지어낸다 — 싣되 재학습 라벨엔 넣지 말라고 한다
    expect(pack!.text).toContain('읽기 전용 문맥');
    expect(pack!.text).toContain('재학습 라벨에 넣지 마세요');
    // 라벨 공간 안의 소견은 평범하게 참고로 실린다
    expect(pack!.text).toContain('반드시 오른다');
  });

  it('답 형식이 `지적:` 한 줄을 요구한다 (18차 V-3)', async () => {
    const id = await seedReview();
    const pack = await buildTeacherPack(prisma, id, deps);
    expect(pack!.packId).toBe(teacherPackId(id));
    expect(pack!.text).toContain(pack!.packId);
    expect(pack!.text).toContain('지적: 타당');
    expect(pack!.text).toContain('지적: 과함');
    for (const label of STUDENT_LABELS) expect(pack!.text).toContain(label);
  });

  it('교정 사례를 주면 **경계 안에** 들어간다 — 사례도 리서처 원문이다 (18차 V-5)', async () => {
    const id = await seedReview();
    const pack = await buildTeacherPack(prisma, id, {
      teacherTag: 'teacher-x',
      corrections: [
        { kind: 'falsePositive', category: 'RUMOR', quote: '업계에 따르면', note: '정상 표현' },
      ],
    });
    const boundary = pack!.text.match(/BOUNDARY-([0-9a-f]{16})/)?.[1];
    expect(pack!.text).toContain(`[오탐사례 BOUNDARY-${boundary}]`);
  });
});

// **목적 재정의: 판정 요청 → 사람 vs 자동 검수 비교 · 재학습 논의** (2026-08-26 창업자 확정).
describe('재학습 논의 자료 — 사람 판정을 나란히 싣는다', () => {
  it('판정을 요청하지 않는다 — 비교·논의 자료임을 명시한다', async () => {
    const id = await seedReview();
    const pack = await buildTeacherPack(prisma, id, deps);
    expect(pack!.text).toContain('판정을 요청하는 것이 아닙니다');
    // IRIS 재학습·학습 표현·BLOCK(코드로만) 셋을 논의 대상으로 건다
    expect(pack!.text).toContain('IRIS 재학습');
    expect(pack!.text).toContain('BLOCK 승격');
    // BLOCK 은 코드로만 — 사전 항목을 켜는 것이 아니라는 경계가 반드시 있어야 한다
    expect(pack!.text).toContain('코드 레벨');
  });

  it('사람 판정이 있으면 결론·유형·사유를 나란히 싣는다', async () => {
    const id = await seedReview();
    await prisma.complianceReview.update({
      where: { id },
      data: {
        operatorVerdict: 'REJECTED',
        operatorCategories: JSON.stringify(['PROFIT_GUARANTEE']),
        operatorReason: '수익 보장 표현이 반복됨',
      },
    });
    const pack = await buildTeacherPack(prisma, id, deps);
    expect(pack!.text).toContain('사람 판정 (운영자)');
    expect(pack!.text).toContain('반려');
    expect(pack!.text).toContain('수익 보장 표현이 반복됨');
    // 자동 검수 판정도 나란히 — 비교의 반대쪽
    expect(pack!.text).toContain('자동 검수(RULE+IRIS) 판정');
  });

  it('아직 판정 전이면 그 사실을 명시한다 — 비교의 절반이 비어 있다', async () => {
    const id = await seedReview();
    const pack = await buildTeacherPack(prisma, id, deps);
    expect(pack!.text).toContain('아직 판정 전입니다');
  });

  it('승인+오탐이면 "오탐"으로, 승인+타당이면 "경미"로 갈라 싣는다', async () => {
    const fp = await seedReview();
    await prisma.complianceReview.update({
      where: { id: fp },
      data: { operatorVerdict: 'APPROVED', aiFindingsValid: false },
    });
    expect((await buildTeacherPack(prisma, fp, deps))!.text).toContain('오탐');

    const minor = await seedReview();
    await prisma.complianceReview.update({
      where: { id: minor },
      data: { operatorVerdict: 'APPROVED', aiFindingsValid: true },
    });
    expect((await buildTeacherPack(prisma, minor, deps))!.text).toContain('경미');
  });

  it('케이스별로 논의 방향이 갈린다 (반려 / 승인+오탐 / 승인+타당)', async () => {
    const rej = await seedReview();
    await prisma.complianceReview.update({
      where: { id: rej },
      data: { operatorVerdict: 'REJECTED', operatorCategories: JSON.stringify(['RUMOR']) },
    });
    // 반려 → 학습 표현 등록·BLOCK 승격이 논의 항목
    expect((await buildTeacherPack(prisma, rej, deps))!.text).toContain('학습 표현 등록');

    const fp = await seedReview();
    await prisma.complianceReview.update({
      where: { id: fp },
      data: { operatorVerdict: 'APPROVED', aiFindingsValid: false },
    });
    // 오탐 → 규칙 점검이 논의 항목
    expect((await buildTeacherPack(prisma, fp, deps))!.text).toContain('규칙 점검');

    const minor = await seedReview();
    await prisma.complianceReview.update({
      where: { id: minor },
      data: { operatorVerdict: 'APPROVED', aiFindingsValid: true },
    });
    // 지적 타당 → 심각도 조정이 논의 항목
    expect((await buildTeacherPack(prisma, minor, deps))!.text).toContain('심각도 조정');
  });
});
