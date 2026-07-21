import type { PrismaClient } from '@prisma/client';
import { getLegalDoc, type LegalDocKey } from '@/domain/legalDocs';

// 약관 동의 이력 기록·조회. 각 문서의 현재 버전(legalDocs.ts) 기준으로 동의를 남긴다.
// 문서 version이 올라가면 이전 동의는 "구버전 동의"로 남고, 재동의가 필요해진다.

export type ConsentContext = 'SIGNUP' | 'RESEARCHER_ACTIVATION' | 'PURCHASE';

export class ConsentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentError';
  }
}

/**
 * 주어진 문서들에 대한 현재 버전 동의를 기록한다.
 * 이미 같은 버전 동의가 있으면 중복 생성하지 않는다 (재로그인 시 스팸 방지).
 */
export async function recordConsents(
  prisma: PrismaClient,
  userId: string,
  docKeys: LegalDocKey[],
  context: ConsentContext,
  now = new Date(),
) {
  for (const docKey of docKeys) {
    const doc = getLegalDoc(docKey);
    if (!doc) throw new ConsentError(`알 수 없는 약관 문서: ${docKey}`);
    const already = await prisma.consent.findFirst({
      where: { userId, docKey, version: doc.version },
    });
    if (already) continue;
    await prisma.consent.create({
      data: { userId, docKey, version: doc.version, context, agreedAt: now },
    });
  }
}

/** 특정 맥락의 단발 동의 기록 (구매 환불 규정 등). note로 대상 식별자를 남긴다 */
export async function recordConsentEvent(
  prisma: PrismaClient,
  userId: string,
  docKey: string,
  version: string,
  context: ConsentContext,
  note?: string,
  now = new Date(),
) {
  await prisma.consent.create({
    data: { userId, docKey, version, context, note: note ?? null, agreedAt: now },
  });
}

export function getUserConsents(prisma: PrismaClient, userId: string) {
  return prisma.consent.findMany({ where: { userId }, orderBy: { agreedAt: 'desc' } });
}
