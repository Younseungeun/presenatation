import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import {
  countOutageHolds,
  engageStudentBypass,
  getStudentBypass,
  getStudentOutageSince,
  recordStudentOutage,
  releaseStudentBypass,
  STUDENT_BYPASS_TTL_MS,
} from '../studentValveService';
import {
  CAP_EXEMPT_LIMIT,
  createLearnedPhrase,
  LearnedPhraseError,
  notifyPhoneticCapOverflow,
  phoneticCapOrder,
  setPhraseCapExempt,
} from '../learnedPhraseService';
import {
  getGraduationWatch,
  getRegressionCases,
  graduatePhrase,
  GraduationError,
  quarantineRegressionCase,
  recordGraduationWatch,
} from '../phraseGraduationService';
import { countHardNegatives, markRetrainAdopted } from '../retrainSignalService';
import { issueOperatorRecheck } from '../operatorApprovalService';
import { runScreening } from '../complianceService';
import { PHONETIC_PHRASE_CAP, type ScreeningInput } from '@/domain/compliance';
import { runRegressionGate } from '@/domain/regressionGate';

// 21차 검토 구현의 경계선들 — 전부 "조용히 약해지는 상태"를 시끄럽게 만드는 장치라,
// 각 장치가 실제로 소리를 내는지(기록·알림·거절)를 붙잡는다.

let prisma: PrismaClient;

beforeAll(async () => {
  prisma = createTestDb('review21-');
  await seedTestInstruments(prisma);
});
afterAll(async () => {
  await prisma.$disconnect();
});

const T0 = Date.parse('2026-08-21T03:00:00Z');

function input(over: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    title: '분석',
    summary: '요약',
    content: '공개 자료 기반 분석입니다.',
    assetClass: 'KR_EQUITY',
    assetName: '삼성전자',
    direction: 'UP',
    ...over,
  };
}

async function operator(email: string) {
  return prisma.user.create({
    data: { email, identityVerified: true, role: 'OPERATOR' },
  });
}

describe('장애 우회 밸브 — 시한폭탄이다 (21차 Y-1(b))', () => {
  it('내리면 2시간 활성, 시간이 지나면 저절로 비활성 — 배치 없이 읽는 순간 만료된다', async () => {
    const op = await operator('valve-op@t.io');
    const now = new Date(T0);
    await engageStudentBypass(prisma, op.id, now);
    expect((await getStudentBypass(prisma, now)).active).toBe(true);
    const later = new Date(T0 + STUDENT_BYPASS_TTL_MS + 1);
    expect((await getStudentBypass(prisma, later)).active).toBe(false);
  });

  it('미리 올릴 수 있다', async () => {
    const op = await operator('valve-op2@t.io');
    await engageStudentBypass(prisma, op.id, new Date(T0));
    await releaseStudentBypass(prisma, op.id);
    expect((await getStudentBypass(prisma, new Date(T0))).active).toBe(false);
  });

  it('내리는 순간 운영자에게 알림이 나간다 — 우회는 조용히 일어나면 안 된다', async () => {
    const op = await operator('valve-op3@t.io');
    await engageStudentBypass(prisma, op.id, new Date(T0));
    // dedupeKey 로 같은 사고의 반복 알림은 억제되므로, 이 파일의 첫 engage 가 만든
    // 알림 한 통이 있는지를 본다 — 재는 것은 "우회가 소리를 냈는가"다
    const n = await prisma.notification.findFirst({
      where: { title: { contains: '장애 우회 밸브' } },
    });
    expect(n).not.toBeNull();
  });

  it('장애 전이 기록 — 시작 시각은 첫 관측에 박히고, 복구가 시각과 밸브를 함께 걷는다', async () => {
    const op = await operator('valve-op4@t.io');
    await recordStudentOutage(prisma, true, new Date(T0));
    const since = await getStudentOutageSince(prisma);
    expect(since?.getTime()).toBe(T0);

    // 두 번째 관측이 시각을 덮어쓰면 "N시간째"가 매번 0으로 리셋된다
    await recordStudentOutage(prisma, true, new Date(T0 + 60_000));
    expect((await getStudentOutageSince(prisma))?.getTime()).toBe(T0);

    // 복구 — 낡은 밸브가 다음 장애 때 되살아나면 안 되므로 함께 걷는다
    await engageStudentBypass(prisma, op.id, new Date(T0));
    await recordStudentOutage(prisma, false, new Date(T0 + 120_000));
    expect(await getStudentOutageSince(prisma)).toBeNull();
    expect((await getStudentBypass(prisma, new Date(T0))).active).toBe(false);
  });
});

describe('runScreening 의 밸브 분기 — 우회는 영구 꼬리표를 단다', () => {
  it('장애 + 밸브 없음 → OUTAGE_HOLD 보류', async () => {
    const r = await runScreening(input(), null, { studentOutage: true });
    expect(r.decision).toBe('UNAVAILABLE');
    expect(r.action).toBe('HOLD');
    expect(r.studentAbsence).toBe('OUTAGE_HOLD');
  });

  it('장애 + 밸브 → 흐르되 VALVE_BYPASS 꼬리표 — "소견 0(정상)"과 갈라진다', async () => {
    const r = await runScreening(input(), null, { studentOutage: true, studentBypass: true });
    expect(r.decision).not.toBe('UNAVAILABLE');
    expect(r.studentAbsence).toBe('VALVE_BYPASS');
    // 대조: 장애가 아니면 꼬리표가 없다
    const normal = await runScreening(input(), null, {});
    expect(normal.studentAbsence).toBeUndefined();
  });

  it('규칙 BLOCK 은 장애·밸브와 무관하게 거절이고 꼬리표를 달지 않는다 (Y-1(a) 그대로)', async () => {
    const r = await runScreening(
      input({ content: '원금 보장해드립니다. 확실합니다.' }),
      null,
      { studentOutage: true },
    );
    expect(r.action).toBe('REJECT');
    expect(r.studentAbsence).toBeUndefined();
    expect(r.studentDown).toBe(true); // 장애 사실 자체는 계기판에 남는다
  });

  it('countOutageHolds 는 전용 칼럼을 센다 — reviewer 문자열이 바뀌어도 죽지 않는다', async () => {
    const before = await countOutageHolds(prisma);
    const user = await prisma.user.create({
      data: { email: 'oh-r@t.io', identityVerified: true },
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
    await prisma.complianceReview.create({
      data: {
        reportId: report.id,
        decision: 'UNAVAILABLE',
        reviewer: '문구가 바뀐 판본', // LIKE 셈법이면 여기서 0이 된다
        findingsJson: '[]',
        needsOperatorReview: true,
        studentAbsence: 'OUTAGE_HOLD',
      },
    });
    expect(await countOutageHolds(prisma)).toBe(before + 1);
  });
});

describe('5층 상한 밀어내기 (21차 Y-2)', () => {
  it('실적 있는 항목이 앞, 무실적 중에서는 최신이 앞 — 밀리는 것은 무실적 최고령', () => {
    const rows = [
      { id: 'old-hit', matchCount: 3, createdAt: new Date(T0 - 3000) },
      { id: 'new-zero', matchCount: 0, createdAt: new Date(T0 - 1000) },
      { id: 'old-zero', matchCount: 0, createdAt: new Date(T0 - 4000) },
      { id: 'new-hit', matchCount: 1, createdAt: new Date(T0 - 2000) },
    ];
    expect(phoneticCapOrder(rows).map((r) => r.id)).toEqual([
      'new-hit',
      'old-hit',
      'new-zero',
      'old-zero', // ← 상한이 자르면 이 항목부터 밀린다
    ]);
  });

  it('상한을 넘는 순간 밀려난 항목의 이름을 불러 알린다', async () => {
    const op = await operator('cap-op@t.io');
    await prisma.learnedPhrase.createMany({
      data: Array.from({ length: PHONETIC_PHRASE_CAP + 1 }, (_, i) => ({
        phrase: `상한시험표현${i}`,
        normalized: `상한시험표현${i}`,
        category: 'UNSUPPORTED_CLAIM',
        createdBy: op.id,
        phoneticEligible: true,
        matchCount: i === 0 ? 0 : 1, // 0번만 무실적 — 그 항목이 밀려야 한다
        createdAt: new Date(T0 + i * 1000),
      })),
    });
    await notifyPhoneticCapOverflow(prisma);
    const n = await prisma.notification.findFirst({
      where: { userId: op.id, title: { contains: '5층 상한 초과' } },
    });
    expect(n).not.toBeNull();
    expect(n!.body).toContain('상한시험표현0');
    await prisma.learnedPhrase.deleteMany({ where: { phrase: { startsWith: '상한시험표현' } } });
  });
});

describe('사전 등록 형태 제약 (21차 Y-6 실측 → 22차 판정: 표본 대조 대신 2어절 하한)', () => {
  it('한 어절 표현은 거절한다 — "있습니다"(종결어미, 4자)가 하한을 통과했었다', async () => {
    // 21차의 대조군 54 기반 관문은 22차가 버렸다: "54건 통과 = 안전"은 "표본이 작아
    // 우연히 안 걸림"과 같은 값이다(gap 17형). 형태 제약은 표본 없이 같은 구멍을 닫는다
    const op = await operator('phrase-op@t.io');
    await expect(
      createLearnedPhrase(prisma, {
        phrase: '있습니다',
        category: 'PROFIT_GUARANTEE',
        createdBy: op.id,
      }),
    ).rejects.toThrow(LearnedPhraseError);
  });

  it('위반을 특정하는 두 어절 이상 표현은 등록된다', async () => {
    const op = await operator('phrase-op2@t.io');
    const created = await createLearnedPhrase(prisma, {
      phrase: '원금 전액 보전 확약',
      category: 'PROFIT_GUARANTEE',
      createdBy: op.id,
    });
    expect(created.id).toBeTruthy();
  });
});

describe('밀어내기 면제권 (22차 Y-2) — 계절성 패턴 보호', () => {
  it('면제 항목은 무실적이어도 맨 앞 — 상한이 잘라도 살아남는다', () => {
    const rows = [
      { id: 'hit', matchCount: 5, createdAt: new Date(T0 - 1000), capExempt: false },
      { id: 'exempt-old-zero', matchCount: 0, createdAt: new Date(T0 - 9000), capExempt: true },
      { id: 'zero', matchCount: 0, createdAt: new Date(T0 - 2000), capExempt: false },
    ];
    expect(phoneticCapOrder(rows).map((r) => r.id)).toEqual(['exempt-old-zero', 'hit', 'zero']);
  });

  it('면제는 20개까지 — 전부 면제면 상한이 없는 것과 같다', async () => {
    const op = await operator('exempt-op@t.io');
    await prisma.learnedPhrase.createMany({
      data: Array.from({ length: CAP_EXEMPT_LIMIT }, (_, i) => ({
        phrase: `면제시험 표현${i}`,
        normalized: `면제시험표현${i}`,
        category: 'UNSUPPORTED_CLAIM',
        createdBy: op.id,
        capExempt: true,
      })),
    });
    const extra = await prisma.learnedPhrase.create({
      data: {
        phrase: '면제시험 초과분',
        normalized: '면제시험초과분',
        category: 'UNSUPPORTED_CLAIM',
        createdBy: op.id,
      },
    });
    await expect(setPhraseCapExempt(prisma, extra.id, true)).rejects.toThrow(/20개까지/);
    // 하나를 풀면 자리가 난다
    const first = await prisma.learnedPhrase.findFirst({ where: { phrase: '면제시험 표현0' } });
    await setPhraseCapExempt(prisma, first!.id, false);
    await setPhraseCapExempt(prisma, extra.id, true);
    await prisma.learnedPhrase.deleteMany({ where: { phrase: { startsWith: '면제시험' } } });
  });
});

describe('졸업 대비쌍 (21차 Y-3)', () => {
  async function seedPhrase(phrase: string) {
    const op = await operator(`grad-${phrase}@t.io`);
    const row = await prisma.learnedPhrase.create({
      data: {
        phrase,
        normalized: phrase.replace(/\s+/g, ''),
        category: 'PROFIT_GUARANTEE',
        createdBy: op.id,
        phoneticEligible: false,
      },
    });
    return { op, row };
  }

  const distinctCases = (tag: string) => [
    { text: `${tag} 원금 보장이 되는 구조라 잃을 일이 없습니다`, expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
    { text: '손실이 나면 제가 사재로 전부 메워드린다고 약속합니다', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
    { text: '최악의 경우에도 원금은 지켜지도록 제도적으로 설계된 상품입니다', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
    { text: '원금 보장은 어떤 경우에도 약속드릴 수 없습니다', expectViolation: false },
    { text: '이 상품은 예금자 보호 대상이 아니며 손실이 날 수 있습니다', expectViolation: false },
    { text: '과거 수익률이 미래의 성과를 보장하지 않는다는 점을 유의하십시오', expectViolation: false },
  ];

// 졸업 관문 보강 (2026-09-01): 공식화 시도 사유 + 항목 질문지 도장이 필수다.
// 이 파일의 시험은 회귀셋·관찰을 재는 것이라 관문은 통과시켜 두고, 관문 자체는
// phraseGraduationGate.db.test 가 잰다
const GRAD_REASON = '보장 뒤 어미 정규식을 시도했으나 부정문과 다른 낱말 표현이 함께 걸려 문자열로는 못 잡는다';
async function stampItemPack(client: PrismaClient, phraseId: string) {
  // 도장 + 샌드박스 실패 기록(정탐 1건 놓침) — 12차 C-4 로 잠금이 사유에서 샌드박스로 바뀌었다
  const probe = { pattern: 'x', isRegex: false, tpTotal: 3, tpHit: 2, tpMiss: 1, normalTotal: 54, normalHit: 0, at: new Date().toISOString() };
  await client.learnedPhrase.update({
    where: { id: phraseId },
    data: { itemPackAskedAt: new Date(), formalizeProbeJson: JSON.stringify(probe), formalizeProbeAt: new Date() },
  });
}

  it('낱말만 바꾼 복붙 3문장은 거절된다 — 명목 3, 실질 1은 회귀셋이 아니다', async () => {
    const { op, row } = await seedPhrase('복붙시험표현');
    const copied = [
      { text: '이 종목은 원금 보장이 확실하게 되는 자리입니다', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
      { text: '이 종목은 원금 보장이 완벽하게 되는 자리입니다', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
      { text: '이 종목은 원금 보장이 넉넉하게 되는 자리입니다', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
      ...distinctCases('x').slice(3),
    ];
    await expect(
      graduatePhrase(prisma, { phraseId: row.id, cases: copied, operatorUserId: op.id, reason: GRAD_REASON }),
    ).rejects.toThrow(/닮았습니다/);
  });

  it('자연스럽게 다른 6문장은 통과하고, graduatedAt 이 박힌다 (관찰 창의 기준점)', async () => {
    const { op, row } = await seedPhrase('졸업시험표현');
    await stampItemPack(prisma, row.id);
    await graduatePhrase(prisma, {
      phraseId: row.id,
      cases: distinctCases('이 종목은'),
      operatorUserId: op.id,
      reason: GRAD_REASON,
    });
    const after = await prisma.learnedPhrase.findUnique({ where: { id: row.id } });
    expect(after!.active).toBe(false);
    expect(after!.graduatedAt).not.toBeNull();
  });

  it('격리는 2인 승인 없이는 거절되고, 승인이 있으면 게이트에서만 빠진다 — 행은 영구', async () => {
    const { op, row } = await seedPhrase('격리시험표현');
    await stampItemPack(prisma, row.id);
    await graduatePhrase(prisma, {
      phraseId: row.id,
      cases: distinctCases('저 종목은'),
      operatorUserId: op.id,
      reason: GRAD_REASON,
    });
    const target = (await prisma.regressionCase.findFirst({
      where: { phraseId: row.id },
    }))!;

    await expect(
      quarantineRegressionCase(prisma, {
        caseId: target.id,
        operatorUserId: op.id,
        reason: '문장이 잘못 쓰였다',
      }),
    ).rejects.toThrow(/승인/);

    const approver = await operator('quarantine-approver@t.io');
    await prisma.operatorApproval.create({
      data: {
        action: 'REGRESSION_CASE_QUARANTINE',
        targetId: target.id,
        summary: '회귀 문항 격리 승인 (시험)',
        status: 'APPROVED',
        requestedBy: op.id,
        reason: '시험',
        decidedBy: approver.id,
        decidedAt: new Date(),
      },
    });
    await quarantineRegressionCase(prisma, {
      caseId: target.id,
      operatorUserId: op.id,
      reason: '문장이 잘못 쓰였다',
    });

    const gate = await getRegressionCases(prisma);
    expect(gate.some((c) => c.id === target.id)).toBe(false);
    const stillThere = await prisma.regressionCase.findUnique({ where: { id: target.id } });
    expect(stillThere).not.toBeNull(); // 삭제가 아니라 격리 — "언제 누가 왜"가 남는다
    expect(stillThere!.quarantineReason).toBe('문장이 잘못 쓰였다');
  });

  // 이 시험만 스위트 중간에 두 번째 DB를 새로 만든다 — 기본 5초가 디스크 경합 아래에서
  // 모자란다 (teacherAnswerService 의 같은 패턴과 동일한 처방)
  it('격리의 1인 갈림길 — 운영자가 1명이면 승인 대신 생체 재확인 표를 소비한다', { timeout: 30_000 }, async () => {
    // 관리자 앱 운영 체제 안내 Q1: 처음 구현은 consumeApproval 만 불러서, 1인 운영에서는
    // 승인을 올릴 상대도 지문을 댈 자리도 없는 **아무도 못 지나가는 문**이었다
    const solo = createTestDb('quarantine-solo-');
    try {
      await seedTestInstruments(solo);
      const op = await solo.user.create({
        data: { email: 'solo-op@t.io', identityVerified: true, role: 'OPERATOR' },
      });
      const phrase = await solo.learnedPhrase.create({
        data: {
          phrase: '단독 격리 표현',
          normalized: '단독격리표현',
          category: 'PROFIT_GUARANTEE',
          createdBy: op.id,
        },
      });
      await stampItemPack(solo, phrase.id);
      await graduatePhrase(solo, {
        phraseId: phrase.id,
        cases: distinctCases('저쪽 종목은'),
        operatorUserId: op.id,
        reason: GRAD_REASON,
      });
      const target = (await solo.regressionCase.findFirst({ where: { phraseId: phrase.id } }))!;

      // 표 없이 → 화면이 지문 창을 띄울 유일한 신호(code)가 실려야 한다
      await expect(
        quarantineRegressionCase(solo, { caseId: target.id, operatorUserId: op.id, reason: '시험' }),
      ).rejects.toMatchObject({ code: 'RECHECK_REQUIRED' });

      // 생체 통과 → 1회용 표 → 통과
      const token = await issueOperatorRecheck(solo, op.id);
      await quarantineRegressionCase(solo, {
        caseId: target.id,
        operatorUserId: op.id,
        reason: '시험',
        recheckToken: token,
      });
      const after = await solo.regressionCase.findUnique({ where: { id: target.id } });
      expect(after!.quarantinedAt).not.toBeNull();
    } finally {
      await solo.$disconnect();
    }
  });

  it('졸업 관찰 — 7일 안에 그 표현이 다시 나타나면 기록되고, 학생 침묵이 함께 남는다', async () => {
    const { op, row } = await seedPhrase('관찰시험표현');
    await stampItemPack(prisma, row.id);
    await graduatePhrase(prisma, {
      phraseId: row.id,
      cases: distinctCases('그 종목은'),
      operatorUserId: op.id,
      reason: GRAD_REASON,
    });
    await recordGraduationWatch(
      prisma,
      'watch-review-1',
      input({ content: '이 리포트에는 관찰시험표현 이 그대로 들어 있습니다.' }),
      [], // 학생 소견 없음 = 침묵
      undefined,
      new Date(),
    );
    const watch = await getGraduationWatch(prisma);
    const mine = watch.find((w) => w.id === row.id);
    expect(mine?.hitCount).toBe(1);
    expect(mine?.studentMissCount).toBe(1); // 학생이 못 잡았다 — 졸업이 성급했다는 증거
  });
});

describe('하드 네거티브 카운터 (20차 X-4 · 21차 Y-5(a))', () => {
  async function seedVerdictReview(opts: {
    shadowFindings: string;
    verdict: string;
    absence?: string;
  }) {
    const user = await prisma.user.create({
      data: { email: `hn${Math.random()}@t.io`, identityVerified: true },
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
    const review = await prisma.complianceReview.create({
      data: {
        reportId: report.id,
        decision: 'WARN',
        reviewer: 'rule',
        findingsJson: '[]',
        needsOperatorReview: true,
        operatorVerdict: opts.verdict,
        studentAbsence: opts.absence ?? null,
      },
    });
    await prisma.shadowComplianceReview.create({
      data: {
        complianceReviewId: review.id,
        reviewer: 'student:test@t0.5/L7',
        findingsJson: opts.shadowFindings,
      },
    });
  }

  it('위반 여부의 엇갈림만 센다 — 결석 건은 표본이 아니다', async () => {
    await markRetrainAdopted(prisma, new Date(T0 - 1)); // 리셋 기준점
    const warn = JSON.stringify([
      { category: 'PROFIT_GUARANTEE', severity: 'WARN', quote: '', reason: 'r', source: 'student' },
    ]);
    await seedVerdictReview({ shadowFindings: warn, verdict: 'APPROVED' }); // 오탐 방향 — 센다
    await seedVerdictReview({ shadowFindings: '[]', verdict: 'REJECTED' }); // 미탐 방향 — 센다
    await seedVerdictReview({ shadowFindings: warn, verdict: 'REJECTED' }); // 일치 — 안 센다
    await seedVerdictReview({ shadowFindings: '[]', verdict: 'APPROVED' }); // 일치 — 안 센다
    await seedVerdictReview({
      shadowFindings: '[]',
      verdict: 'REJECTED',
      absence: 'OUTAGE_HOLD', // 결석 — 세면 장애가 학생의 미탐으로 오염된다 (gap 17형)
    });
    const r = await countHardNegatives(prisma);
    expect(r.count).toBe(2);
    expect(r.reached).toBe(false);
  });
});

describe('회귀 게이트 (21차 Y-5(b)) — 전 건 통과, 호출 실패도 오답', () => {
  const cases = [
    { id: 'v1', text: '원금 보장 문장', expectViolation: true, category: 'PROFIT_GUARANTEE' },
    { id: 'n1', text: '정상 문장', expectViolation: false, category: null },
  ];

  it('위반은 기대 유형이 있어야, 정상은 소견이 없어야 통과다', async () => {
    const good = await runRegressionGate(cases, async (i) =>
      i.content.includes('원금')
        ? [{ category: 'PROFIT_GUARANTEE', severity: 'WARN', quote: '', reason: 'r', source: 'student' } as const]
        : [],
    );
    expect(good.pass).toBe(true);

    const forgot = await runRegressionGate(cases, async () => []);
    expect(forgot.pass).toBe(false);
    expect(forgot.failures.map((f) => f.id)).toEqual(['v1']);
  });

  it('호출 실패는 통과가 아니다 — 게이트가 못 잰 모델을 통과시키면 게이트가 없는 것', async () => {
    const dead = await runRegressionGate(cases, async () => {
      throw new Error('사이드카 없음');
    });
    expect(dead.pass).toBe(false);
    expect(dead.failures).toHaveLength(2);
  });
});
