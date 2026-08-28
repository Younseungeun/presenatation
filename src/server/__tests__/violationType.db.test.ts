import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureViolationType,
  getCustomViolationTypes,
  isBuiltinCategory,
  validateViolationTypeLabel,
} from '../violationTypeService';
import { createTestDb } from './helpers/testDb';

// 운영자 정의 위반 유형 (2026-08-28 창업자 지시) — 강제 철회·반려 때 "위반 유형 추가"로
// 새 유형을 만든다. label 자체가 operatorCategories 에 저장되는 key 다.

let prisma: PrismaClient;
const OP = 'op-user-1';

beforeAll(() => {
  prisma = createTestDb('violation-type-');
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe('validateViolationTypeLabel', () => {
  it('빈 값·공백만·너무 긴 값은 거절한다', () => {
    expect('error' in validateViolationTypeLabel('')).toBe(true);
    expect('error' in validateViolationTypeLabel('   ')).toBe(true);
    expect('error' in validateViolationTypeLabel('가'.repeat(41))).toBe(true);
  });
  it('내장 유형 key·label 과 겹치면 거절한다 — 같은 뜻이 두 key 로 갈라지면 집계가 쪼개진다', () => {
    expect('error' in validateViolationTypeLabel('PROFIT_GUARANTEE')).toBe(true);
    expect('error' in validateViolationTypeLabel('수익 보장·손실 보전 표현')).toBe(true);
  });
  it('정상 라벨은 trim·공백 정규화해 통과시킨다', () => {
    const r = validateViolationTypeLabel('  논리적   비약  ');
    expect(r).toEqual({ label: '논리적 비약' });
  });
});

describe('ensureViolationType', () => {
  it('커스텀 유형을 만들고 getCustomViolationTypes 에 뜬다', async () => {
    const key = await ensureViolationType(prisma, '논리적 비약', OP, 'report-1');
    expect(key).toBe('논리적 비약');
    expect(await getCustomViolationTypes(prisma)).toContain('논리적 비약');
  });

  it('멱등하다 — 같은 라벨을 다시 보장해도 행이 하나뿐이다', async () => {
    await ensureViolationType(prisma, '과장 광고', OP, 'report-2');
    await ensureViolationType(prisma, '과장 광고', OP, 'report-3');
    const rows = await prisma.violationType.findMany({ where: { label: '과장 광고' } });
    expect(rows.length).toBe(1);
  });

  it('내장 유형은 그대로 통과시키고 ViolationType 을 만들지 않는다', async () => {
    const before = await prisma.violationType.count();
    const key = await ensureViolationType(prisma, 'PROFIT_GUARANTEE', OP);
    expect(key).toBe('PROFIT_GUARANTEE');
    expect(isBuiltinCategory('PROFIT_GUARANTEE')).toBe(true);
    expect(await prisma.violationType.count()).toBe(before);
  });

  it('비활성 유형은 다시 보장하면 되살아난다', async () => {
    await ensureViolationType(prisma, '유인성 표현', OP);
    await prisma.violationType.update({
      where: { label: '유인성 표현' },
      data: { active: false },
    });
    expect(await getCustomViolationTypes(prisma)).not.toContain('유인성 표현');
    await ensureViolationType(prisma, '유인성 표현', OP);
    expect(await getCustomViolationTypes(prisma)).toContain('유인성 표현');
  });

  it('검증 실패(빈 값)는 던진다 — 오타가 곧 없는 유형이 되면 안 된다', async () => {
    await expect(ensureViolationType(prisma, '   ', OP)).rejects.toThrow();
  });
});
