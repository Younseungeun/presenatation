import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/testDb';
import { graduatePhrase, GraduationError } from '../phraseGraduationService';
import type { FormalizationProbeResult } from '@/domain/formalizationProbe';

// 졸업 관문 보강 (2026-09-01 창업자 확정 → 12차 검토 C-4 로 교체) — "코드로 못 적는가"를 묻는 두 관문.
//
// ── 이 시험이 있는 이유 (탐침 실측) ────────────────────────────────────
// 종전 관문(대비쌍 3/3 · 복붙 유사도)은 **회귀셋의 품질**만 보고 "넘겨야 하나"는 안 물었다.
// 누가 봐도 문자열 하나로 잡히는 "원금 보장"(위반 3문장이 정확히 같은 출현형)을 문장의
// 나머지만 다르게 써서 넣었더니 졸업이 그대로 통과됐다. 그래서:
//   ① 항목 질문지를 한 번은 뽑았어야 한다 (공식화를 검토했다는 도장)
//   ② **공식화 샌드박스에서 실패한 기록**이 있어야 한다 (C-4: 20자 사유는 보일러플레이트가 된다)
//      — 정탐을 놓쳤거나 정상 문장을 잡았으면 실패 = 졸업. 다 잡았으면 규칙 승격감이라 잠긴다
// 형태 굳음·ARGOS 동반 0 은 **경고만**이라 여기서 재지 않는다(화면의 몫).

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createTestDb('gradgate');
});
afterAll(async () => {
  await prisma.$disconnect();
});

const cases = [
  { text: '이 종목은 원금 보장 상품처럼 안전하니 지금 들어가도 됩니다.', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
  { text: '분기 실적이 좋아서 사실상 손실은 없다고 보셔도 무방합니다.', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
  { text: '기관이 받쳐 주니 전액 케어되는 수준의 하방 방어가 됩니다.', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
  { text: '원금 보장 상품이 아니므로 손실이 날 수 있음을 유의하십시오.', expectViolation: false },
  { text: '이 리포트는 어떤 수익도 약속하지 않으며 투자 판단은 본인 몫입니다.', expectViolation: false },
  { text: '과거 수익률은 미래 수익을 뜻하지 않습니다.', expectViolation: false },
];

const probe = (over: Partial<FormalizationProbeResult>): FormalizationProbeResult => ({
  pattern: '원금 보장',
  isRegex: false,
  tpTotal: 3,
  tpHit: 3,
  tpMiss: 0,
  normalTotal: 57,
  normalHit: 0,
  at: new Date().toISOString(),
  ...over,
});

async function seedPhrase(text: string, data: { itemPackAskedAt?: Date; probe?: FormalizationProbeResult } = {}) {
  return prisma.learnedPhrase.create({
    data: {
      phrase: text,
      normalized: text.replace(/\s/g, ''),
      category: 'PROFIT_GUARANTEE',
      createdBy: 'op',
      itemPackAskedAt: data.itemPackAskedAt ?? null,
      formalizeProbeJson: data.probe ? JSON.stringify(data.probe) : null,
      formalizeProbeAt: data.probe ? new Date() : null,
    },
  });
}

describe('졸업 관문 — 코드로 못 적는가', () => {
  it('항목 질문지를 한 번도 안 뽑은 표현은 졸업되지 않는다', async () => {
    const p = await seedPhrase('도장 없는 표현', { probe: probe({ tpMiss: 1 }) });
    await expect(graduatePhrase(prisma, { phraseId: p.id, cases, operatorUserId: 'op' })).rejects.toThrow(/질문지/);
    const after = await prisma.learnedPhrase.findUnique({ where: { id: p.id } });
    expect(after?.active).toBe(true);
  });

  it('도장은 있어도 샌드박스를 안 돌렸으면 졸업되지 않는다', async () => {
    const p = await seedPhrase('샌드박스 없는 표현', { itemPackAskedAt: new Date() });
    await expect(graduatePhrase(prisma, { phraseId: p.id, cases, operatorUserId: 'op' })).rejects.toThrow(/샌드박스/);
  });

  it('샌드박스가 다 잡았으면(공식화 성공) 졸업이 아니라 규칙 승격감 — 잠긴다', async () => {
    const p = await seedPhrase('공식화 성공 표현', { itemPackAskedAt: new Date(), probe: probe({}) });
    await expect(graduatePhrase(prisma, { phraseId: p.id, cases, operatorUserId: 'op' })).rejects.toThrow(/승격 후보/);
    await expect(graduatePhrase(prisma, { phraseId: p.id, cases, operatorUserId: 'op' })).rejects.toBeInstanceOf(GraduationError);
  });

  it('정탐을 놓친 기록이 있으면 졸업된다 — 메모는 선택', async () => {
    const p = await seedPhrase('정탐 놓친 표현', { itemPackAskedAt: new Date(), probe: probe({ tpHit: 2, tpMiss: 1 }) });
    const r = await graduatePhrase(prisma, { phraseId: p.id, cases, operatorUserId: 'op' });
    expect(r.registered).toBe(6);
    const after = await prisma.learnedPhrase.findUnique({ where: { id: p.id } });
    expect(after?.active).toBe(false);
    expect(after?.graduatedAt).not.toBeNull();
    expect(after?.graduationReason).toBeNull();
  });

  it('정상 문장을 잡은(오탐) 기록이 있어도 졸업된다 — 메모가 있으면 남는다', async () => {
    const p = await seedPhrase('오탐 난 표현', { itemPackAskedAt: new Date(), probe: probe({ normalHit: 2 }) });
    await graduatePhrase(prisma, { phraseId: p.id, cases, operatorUserId: 'op', reason: '부정문이 같이 걸린다' });
    const after = await prisma.learnedPhrase.findUnique({ where: { id: p.id } });
    expect(after?.active).toBe(false);
    expect(after?.graduationReason).toBe('부정문이 같이 걸린다');
  });

  it('관문 순서: 복붙 검사가 먼저 걸린다 (도장·샌드박스 없어도 복붙 오류가 우선) — 기존 시험의 기대를 깨지 않는다', async () => {
    const p = await seedPhrase('복붙 우선 표현');
    const copied = [
      { text: '이 종목은 원금 보장이 확실하게 되는 자리입니다', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
      { text: '이 종목은 원금 보장이 완벽하게 되는 자리입니다', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
      { text: '이 종목은 원금 보장이 넉넉하게 되는 자리입니다', expectViolation: true, category: 'PROFIT_GUARANTEE' as const },
      ...cases.slice(3),
    ];
    await expect(graduatePhrase(prisma, { phraseId: p.id, cases: copied, operatorUserId: 'op' })).rejects.toThrow(
      /닮았습니다/,
    );
  });
});
