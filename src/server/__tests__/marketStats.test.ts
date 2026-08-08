import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DELTA_WINDOW_MS,
  formatDelta,
  formatKrw,
  getMarketStats,
  takeMarketSnapshot,
} from '../marketStats';
import { createTestDb } from './helpers/testDb';

// 띠지에 흐르는 숫자. 무엇을 넣고 빼는지가 핵심이라 그 규칙을 고정한다.

describe('금액 표기 — 자릿수가 길면 띠지에서 안 읽힌다', () => {
  it('만 단위 아래는 그대로', () => {
    expect(formatKrw(0)).toBe('0원');
    expect(formatKrw(9_900)).toBe('9,900원');
  });

  it('만원 단위로 접는다', () => {
    expect(formatKrw(10_000)).toBe('1만원');
    expect(formatKrw(1_240_000)).toBe('124만원');
  });

  it('억부터는 소수 한 자리', () => {
    expect(formatKrw(100_000_000)).toBe('1.0억원');
    expect(formatKrw(253_000_000)).toBe('2.5억원');
  });
});

describe('증감 표기', () => {
  it('변화가 없으면 아무것도 적지 않는다 — "(0)"은 정보가 아니라 잡음이다', () => {
    expect(formatDelta(0, false)).toBeNull();
    expect(formatDelta(0, true)).toBeNull();
  });

  it('방향은 값으로 들고 다닌다 — 문자열에서 부호를 다시 읽으면 표기를 바꿀 때 깨진다', () => {
    expect(formatDelta(3, false)).toEqual({ up: true, amount: '3' });
    expect(formatDelta(-2, false)).toEqual({ up: false, amount: '2' });
  });

  it('부호를 붙이지 않는다 — 화살표가 이미 방향을 말한다', () => {
    expect(formatDelta(-2, false)?.amount).not.toContain('−');
    expect(formatDelta(3, false)?.amount).not.toContain('+');
  });

  it('금액은 금액 표기를 따른다', () => {
    expect(formatDelta(30_000, true)).toEqual({ up: true, amount: '3만원' });
    expect(formatDelta(-10_000, true)).toEqual({ up: false, amount: '1만원' });
  });
});

describe('증감은 스냅샷과 견준다', () => {
  let prisma: PrismaClient;
  const NOW = new Date('2026-08-09T12:00:00Z');

  beforeAll(async () => {
    prisma = createTestDb('market-delta-');
    const user = await prisma.user.create({
      data: { email: 'd@test.io', penName: '리서처', identityVerified: true },
    });
    const profile = await prisma.researcherProfile.create({ data: { userId: user.id } });
    await prisma.report.create({
      data: {
        researcherId: profile.id,
        title: 'ㄱ',
        summary: 'ㄱ',
        content: 'ㄱ',
        priceKrw: 9_900,
        status: 'PUBLISHED',
        publishedAt: NOW,
      },
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('비교할 스냅샷이 없으면 증감을 적지 않는다 — 지금 값을 증가분으로 적으면 거짓말이 된다', async () => {
    const stats = await getMarketStats(prisma, { includeAmounts: false }, NOW);
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.every((s) => s.delta === null)).toBe(true);
  });

  it('창(24시간) 안쪽 스냅샷은 기준이 되지 않는다 — 하루 전과 견주는 값이다', async () => {
    // 1시간 전 스냅샷만 있는 상태
    await takeMarketSnapshot(prisma, new Date(NOW.getTime() - 3_600_000));
    const stats = await getMarketStats(prisma, { includeAmounts: false }, NOW);
    expect(stats.every((s) => s.delta === null)).toBe(true);
  });

  it('창 이전 스냅샷이 있으면 그것과의 차이를 적는다', async () => {
    await takeMarketSnapshot(prisma, new Date(NOW.getTime() - DELTA_WINDOW_MS - 60_000));

    // 스냅샷 이후에 리서처가 한 명 더 게시했다
    const user = await prisma.user.create({
      data: { email: 'd2@test.io', penName: '리서처2', identityVerified: true },
    });
    const profile = await prisma.researcherProfile.create({ data: { userId: user.id } });
    await prisma.report.create({
      data: {
        researcherId: profile.id,
        title: 'ㄴ',
        summary: 'ㄴ',
        content: 'ㄴ',
        priceKrw: 9_900,
        status: 'PUBLISHED',
        publishedAt: NOW,
      },
    });

    const stats = await getMarketStats(prisma, { includeAmounts: false }, NOW);
    const researchers = stats.find((s) => s.key === 'researchers');
    expect(researchers?.value).toBe('2명');
    expect(researchers?.delta).toEqual({ up: true, amount: '1' });
  });

  it('"최근 24시간 새 카드"에는 증감을 붙이지 않는다 — 증가분의 증가분은 읽을 수 없다', async () => {
    const stats = await getMarketStats(prisma, { includeAmounts: false }, NOW);
    expect(stats.find((s) => s.key === 'fresh')?.delta).toBeNull();
  });
});

describe('집계 규칙', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestDb('market-stats-');
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('빈 마켓은 아무것도 흘리지 않는다 (0장·0건이 흐르지 않는다)', async () => {
    // 빈 마켓을 광고하는 것보다 그 줄을 없애는 편이 정직하고 낫다
    expect(await getMarketStats(prisma, { includeAmounts: true })).toEqual([]);
  });

  it('금액을 끄면 금액 항목이 애초에 집계되지 않는다', async () => {
    const stats = await getMarketStats(prisma, { includeAmounts: false });
    expect(stats.some((s) => s.isAmount)).toBe(false);
  });

  it('플랫폼 평균 적중률은 항목에 없다', async () => {
    // 높으면 "예측이 잘 맞는다"는 홍보가 되어 투자권유 소지가 생기고(기획 §1),
    // 낮으면 서비스를 스스로 부정한다. 적중률은 리서처 개인의 트랙레코드일 때만 뜻이 있다
    const stats = await getMarketStats(prisma, { includeAmounts: true });
    expect(stats.some((s) => s.label.includes('적중'))).toBe(false);
  });

  it('수치가 생기면 그 항목만 흐른다', async () => {
    const user = await prisma.user.create({
      data: { email: 'r@test.io', penName: '리서처', identityVerified: true },
    });
    const profile = await prisma.researcherProfile.create({ data: { userId: user.id } });
    await prisma.report.create({
      data: {
        researcherId: profile.id,
        title: '제목',
        summary: '요약',
        content: '본문',
        priceKrw: 9_900,
        status: 'PUBLISHED',
        publishedAt: new Date(),
      },
    });

    const stats = await getMarketStats(prisma, { includeAmounts: false });
    const keys = stats.map((s) => s.key);
    // 게시한 리서처가 생겼고 24시간 안에 올라온 카드도 생겼다
    expect(keys).toContain('researchers');
    expect(keys).toContain('fresh');
    // 예측 카드가 없는 글이라 검증 중 카드는 여전히 0 → 흐르지 않는다
    expect(keys).not.toContain('verifying');
    expect(keys).not.toContain('judged');
  });
});
