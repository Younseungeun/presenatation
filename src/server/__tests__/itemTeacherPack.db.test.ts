import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import {
  buildItemTeacherPack,
  getIrisCategoryCounts,
  IRIS_ITEM_PREFIX,
  ItemPackError,
  registerPhraseFromIris,
} from '../itemTeacherPackService';

// 검출 항목별 질문지의 **수집 경로** (2026-09-01) — 조립기는 순수 시험이 지키고, 여기서는
// 두 층의 증거가 실제 표에서 같은 모양으로 접히는지를 본다:
//   학습표현 = LearnedPhraseHit 스냅샷 + 검수 기록의 aiFindingsValid 로 승인을 오탐/경미로 가름
//   규칙 WARN = findingsJson 의 소견(quote·layer) + 그 기록의 판정

let prisma: PrismaClient;

async function seedReport() {
  const user = await prisma.user.create({
    data: { email: `r${Math.random()}@t.io`, identityVerified: true },
  });
  const researcher = await prisma.researcherProfile.create({ data: { userId: user.id } });
  const report = await prisma.report.create({
    data: {
      researcherId: researcher.id,
      title: '테스트',
      summary: '요약',
      content: '본문',
      priceKrw: 10_000,
      feeRateBp: 2_000,
      status: 'PENDING_REVIEW',
    },
  });
  return { report, researcher };
}

beforeAll(() => {
  prisma = createTestDb('itempack');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('buildItemTeacherPack', () => {
  it('학습표현: hit 스냅샷을 모으고, 승인은 검수 기록의 aiFindingsValid 로 오탐/경미를 가른다', async () => {
    const phrase = await prisma.learnedPhrase.create({
      data: { phrase: '인스타 문의', normalized: '인스타문의', category: 'SOLICIT_CONTACT', createdBy: 'op' },
    });
    const ruleId = `learned:${phrase.id}`;
    // 반려 1건 / 승인+지적 타당(경미) 1건
    const a = await seedReport();
    const b = await seedReport();
    await prisma.complianceReview.create({
      data: {
        reportId: a.report.id,
        decision: 'WARN',
        reviewer: 'rule',
        findingsJson: JSON.stringify([{ category: 'SOLICIT_CONTACT', severity: 'WARN', quote: 'q', reason: 'r', ruleId, source: 'learned' }]),
        operatorVerdict: 'REJECTED',
      },
    });
    await prisma.complianceReview.create({
      data: {
        reportId: b.report.id,
        decision: 'WARN',
        reviewer: 'rule',
        findingsJson: JSON.stringify([{ category: 'SOLICIT_CONTACT', severity: 'WARN', quote: 'q', reason: 'r', ruleId, source: 'learned' }]),
        operatorVerdict: 'APPROVED',
        aiFindingsValid: true,
      },
    });
    await prisma.learnedPhraseHit.createMany({
      data: [
        {
          phraseId: phrase.id,
          reportId: a.report.id,
          researcherId: a.researcher.id,
          matchedSentence: '궁금하면 인스타 문의 주세요',
          matchedSurface: '인스타 문의',
          verdict: 'REJECTED',
        },
        {
          phraseId: phrase.id,
          reportId: b.report.id,
          researcherId: b.researcher.id,
          matchedSentence: '인스타 문의가 늘어난 것은 브랜드 지표다',
          matchedSurface: '인스타 문의가',
          verdict: 'APPROVED',
        },
      ],
    });

    const pack = await buildItemTeacherPack(prisma, ruleId);
    expect(pack.count).toBe(2);
    expect(pack.title).toContain('인스타 문의');
    expect(pack.text).toContain('### 정탐');
    expect(pack.text).toContain('궁금하면 인스타 문의 주세요');
    // 승인+지적 타당 → 경미 (오탐이 아니다) — hit.verdict 만으로는 못 가르는 값
    expect(pack.text).toContain('### 경미');
    expect(pack.text).not.toContain('### 오탐');
    expect(pack.text).toContain('“인스타 문의가” × 1');
    expect(pack.text).toContain('규칙 WARN 으로 올릴 수 있나');
  });

  it('규칙 WARN: 소견의 quote·layer 를 모으고 다른 규칙의 소견은 섞지 않는다', async () => {
    const r = await seedReport();
    await prisma.complianceReview.create({
      data: {
        reportId: r.report.id,
        decision: 'WARN',
        reviewer: 'rule',
        findingsJson: JSON.stringify([
          // surface = 정확한 출현형 (2026-09-01) — 규칙 항목의 출현형 요약은 이 값으로 센다
          { category: 'PROFIT_GUARANTEE', severity: 'WARN', quote: '원 금 보 장 됩니다', surface: '원 금 보 장', reason: '수익 보장 표현', ruleId: 'PROFIT_GUARANTEE', layer: 'L2_SEPARATOR', source: 'rule' },
          { category: 'RISK_INDUCEMENT', severity: 'WARN', quote: '풀매수 추천', reason: '위험 유도', ruleId: 'RISK_INDUCEMENT', layer: 'L1_RAW', source: 'rule' },
        ]),
        operatorVerdict: 'APPROVED',
        aiFindingsValid: false,
      },
    });

    const pack = await buildItemTeacherPack(prisma, 'PROFIT_GUARANTEE');
    expect(pack.count).toBe(1);
    expect(pack.text).toContain('### 오탐');
    expect(pack.text).toContain('[출현형 "원 금 보 장" · L2_SEPARATOR] “원 금 보 장 됩니다”');
    expect(pack.text).toContain('규칙 사유문: 수익 보장 표현');
    // 규칙 항목도 출현형 요약이 채워진다 (surface 도입 후)
    expect(pack.text).toContain('“원 금 보 장” × 1');
    expect(pack.text).not.toContain('풀매수 추천');
    expect(pack.text).toContain('BLOCK 으로 올릴 수 있나');
  });

  it('IRIS 유형별 모음: IRIS 만 잡은/놓친 확정 건의 근거 문장만 — 규칙이 잡은 건·근거 없는 건은 뺀다', async () => {
    const student = (category: string) => ({ category, severity: 'WARN', quote: '', reason: 'r', source: 'student' });
    const mk = async (data: {
      findings: unknown[];
      verdict: string;
      evidence?: string[];
      categories?: string[];
    }) => {
      const r = await seedReport();
      await prisma.complianceReview.create({
        data: {
          reportId: r.report.id,
          decision: 'WARN',
          reviewer: 'rule',
          findingsJson: JSON.stringify(data.findings),
          operatorVerdict: data.verdict,
          operatorEvidence: data.evidence ? JSON.stringify(data.evidence) : null,
          operatorCategories: data.categories ? JSON.stringify(data.categories) : null,
        },
      });
    };
    // ① IRIS 만 잡고 반려 + 근거 있음 → 포함 (검출)
    await mk({ findings: [student('SOLICIT_CONTACT')], verdict: 'REJECTED', evidence: ['자세한 건 디엠 주세요'] });
    // ② 아무도 못 잡고 통과 후 철회(미탐) + 운영자 지목 유형 → 포함 (미탐)
    await mk({ findings: [], verdict: 'MISSED', evidence: ['노란 앱으로 오세요'], categories: ['SOLICIT_CONTACT'] });
    // ③ 규칙도 잡은 건 → 제외 (항목 질문지의 몫)
    await mk({
      findings: [student('SOLICIT_CONTACT'), { category: 'SOLICIT_CONTACT', severity: 'WARN', quote: 'q', reason: 'r', ruleId: 'X', source: 'rule' }],
      verdict: 'REJECTED',
      evidence: ['규칙도 잡은 문장'],
    });
    // ④ IRIS 만 잡았지만 근거 없음 → 제외 (문장이 없다)
    await mk({ findings: [student('SOLICIT_CONTACT')], verdict: 'REJECTED' });
    // ⑤ IRIS 만 잡았는데 승인(오탐) → 제외 (확정 위반이 아니다)
    // 질문지 본문에 "정상 문장"이라는 낱말이 원래 있으므로(논의 항목) 겹치지 않는 문장으로
    await mk({ findings: [student('SOLICIT_CONTACT')], verdict: 'APPROVED', evidence: ['승인된 건의 문장 QZX'] });

    const counts = await getIrisCategoryCounts(prisma);
    const sc = counts.find((c) => c.category === 'SOLICIT_CONTACT');
    expect(sc).toEqual({ category: 'SOLICIT_CONTACT', cases: 2, detected: 1, missed: 1, sentences: 2 });

    const pack = await buildItemTeacherPack(prisma, `${IRIS_ITEM_PREFIX}SOLICIT_CONTACT`);
    expect(pack.count).toBe(2);
    expect(pack.text).toContain('[IRIS 검출] “자세한 건 디엠 주세요”');
    expect(pack.text).toContain('[IRIS 미탐] “노란 앱으로 오세요”');
    expect(pack.text).not.toContain('규칙도 잡은 문장');
    expect(pack.text).not.toContain('승인된 건의 문장 QZX');
    expect(pack.text).toContain('졸업 강등 본선');
    await expect(buildItemTeacherPack(prisma, `${IRIS_ITEM_PREFIX}NOPE`)).rejects.toBeInstanceOf(ItemPackError);
  });

  it('없는 항목·대상 밖 층은 ItemPackError', async () => {
    await expect(buildItemTeacherPack(prisma, 'learned:nope')).rejects.toBeInstanceOf(ItemPackError);
  });
});

describe('registerPhraseFromIris — 본선 실행 통로 (Q1)', () => {
  const student = (category: string) => ({ category, severity: 'WARN', quote: '', reason: 'r', source: 'student' });

  it('IRIS 확정 건이 있는 유형은 등록되고, 출처(sourceReportId)가 그 건으로 물린다', async () => {
    const r = await seedReport();
    await prisma.complianceReview.create({
      data: {
        reportId: r.report.id,
        decision: 'WARN',
        reviewer: 'rule',
        findingsJson: JSON.stringify([student('SOLICIT_CONTACT')]),
        operatorVerdict: 'REJECTED',
        operatorEvidence: JSON.stringify(['노란 앱으로 오세요']),
      },
    });
    const created = await registerPhraseFromIris(prisma, {
      category: 'SOLICIT_CONTACT',
      phrase: '노란색 앱으로', // 정규화 4자 이상·2어절 (하한 통과)
      operatorUserId: 'op',
    });
    const row = await prisma.learnedPhrase.findUnique({ where: { id: created.id } });
    expect(row?.active).toBe(true);
    expect(row?.category).toBe('SOLICIT_CONTACT');
    expect(row?.sourceReportId).toBe(r.report.id); // 출처가 근거 건으로 물렸다
  });

  it('그 유형에 확정 건이 없으면 거부한다 — 출처 없이 등록할 수 없다 (T9)', async () => {
    await expect(
      registerPhraseFromIris(prisma, { category: 'RUMOR', phrase: '카더라 소문', operatorUserId: 'op' }),
    ).rejects.toThrow(/근거가 된 확정 건이 없습니다/);
  });

  it('2어절 미만 표현은 검증에서 거부한다 (같은 함수·같은 규칙)', async () => {
    const r = await seedReport();
    await prisma.complianceReview.create({
      data: {
        reportId: r.report.id,
        decision: 'WARN',
        reviewer: 'rule',
        findingsJson: JSON.stringify([student('PROFIT_GUARANTEE')]),
        operatorVerdict: 'TAKEDOWN',
        operatorEvidence: JSON.stringify(['원금을 보장합니다']),
      },
    });
    await expect(
      registerPhraseFromIris(prisma, { category: 'PROFIT_GUARANTEE', phrase: '보장', operatorUserId: 'op' }),
    ).rejects.toBeInstanceOf(ItemPackError);
  });
});
