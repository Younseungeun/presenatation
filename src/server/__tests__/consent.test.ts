import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { LEGAL_DOCS, SIGNUP_REQUIRED_DOCS } from '@/domain/legalDocs';
import { getUserConsents, recordConsentEvent, recordConsents } from '../consentService';

// 약관 동의 이력: 현재 버전 동의 기록, 재로그인 시 중복 방지, 구매 단발 동의 기록

let prisma: PrismaClient;
let userId: string;

beforeAll(async () => {
  prisma = createTestDb('consent-');
  userId = (await prisma.user.create({ data: { email: 'c@t.io', identityVerified: true } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('recordConsents — 필수 약관 동의', () => {
  it('가입 시 필수 문서 동의를 현재 버전으로 기록', async () => {
    await recordConsents(prisma, userId, SIGNUP_REQUIRED_DOCS, 'SIGNUP');
    const consents = await getUserConsents(prisma, userId);
    expect(consents).toHaveLength(2);
    expect(consents.map((c) => c.docKey).sort()).toEqual(['PRIVACY_POLICY', 'TERMS_OF_SERVICE']);
    // 문서마다 버전이 다르므로 순서에 기대지 않고 키로 찾는다
    const terms = consents.find((c) => c.docKey === 'TERMS_OF_SERVICE')!;
    expect(terms.version).toBe(LEGAL_DOCS.TERMS_OF_SERVICE.version);
    expect(terms.context).toBe('SIGNUP');
  });

  it('같은 버전 재동의는 중복 기록하지 않는다 (재로그인 스팸 방지)', async () => {
    await recordConsents(prisma, userId, SIGNUP_REQUIRED_DOCS, 'SIGNUP');
    expect(await getUserConsents(prisma, userId)).toHaveLength(2);
  });
});

describe('recordConsentEvent — 구매 단발 동의', () => {
  it('구매마다 환불 규정 동의를 대상 리포트와 함께 기록', async () => {
    await recordConsentEvent(prisma, userId, 'REFUND_POLICY', 'v1', 'PURCHASE', 'report-abc');
    await recordConsentEvent(prisma, userId, 'REFUND_POLICY', 'v1', 'PURCHASE', 'report-def');
    const refunds = (await getUserConsents(prisma, userId)).filter(
      (c) => c.docKey === 'REFUND_POLICY',
    );
    expect(refunds).toHaveLength(2); // 구매 건마다 개별 기록
    expect(refunds.map((c) => c.note).sort()).toEqual(['report-abc', 'report-def']);
  });
});
