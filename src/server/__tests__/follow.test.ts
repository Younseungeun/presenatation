import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import {
  followResearcher,
  FollowError,
  getFollowedResearcherIds,
  getFollowerList,
  getFollowingList,
  getFollowStats,
  NEW_CARD_NOTIFICATION_TYPE,
  unfollowResearcher,
} from '../followService';
import { getFollowedResearcherCards } from '../marketQueries';
import { createDraftReport, publishReport } from '../reportService';

// 팔로우: 구독 관계 자체 + 새 카드 알림 + 리더보드 모아보기까지 한 흐름으로 검증한다.

let prisma: PrismaClient;
let researcherId: string;
let researcherUserId: string;
let otherResearcherId: string;
let followerId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');

function registry(ticker: string): ProviderRegistry {
  return { CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100) };
}

async function publishCard(rid: string, ticker: string, title: string) {
  const draft = await createDraftReport(
    prisma,
    {
      researcherId: rid,
      title,
      summary: 's',
      content: 'c',
      priceKrw: 10_000,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker,
        assetName: ticker,
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 12,
        confidence: 5,
        selfStability: 1,
        selfProfitability: 5,
        deadline: DEADLINE,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, registry(ticker), draft.id, rid, PUBLISH_NOW);
  return draft.id;
}

beforeAll(async () => {
  prisma = createTestDb('follow-');
  await seedTestInstruments(prisma);

  const r = await prisma.user.create({
    data: { email: 'r@f.io', penName: '따라갈 리서처', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  researcherUserId = r.id;

  const o = await prisma.user.create({
    data: { email: 'o@f.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  otherResearcherId = o.researcherProfile!.id;

  followerId = (await prisma.user.create({ data: { email: 'f@f.io', identityVerified: true } })).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('followResearcher / unfollowResearcher', () => {
  it('팔로우하면 관계가 생기고, 중복 요청은 조용히 성공한다 (버튼 연타 대비)', async () => {
    expect(await followResearcher(prisma, followerId, researcherId)).toEqual({ following: true });
    expect(await followResearcher(prisma, followerId, researcherId)).toEqual({ following: true });
    expect(await prisma.follow.count({ where: { followerId, researcherId } })).toBe(1);
  });

  it('자기 자신은 팔로우할 수 없다', async () => {
    await expect(followResearcher(prisma, researcherUserId, researcherId)).rejects.toThrow(
      FollowError,
    );
  });

  it('없는 리서처는 거부', async () => {
    await expect(followResearcher(prisma, followerId, 'nope')).rejects.toThrow(/존재하지 않는/);
  });

  it('언팔로우는 멱등 — 팔로우 중이 아니어도 성공', async () => {
    expect(await unfollowResearcher(prisma, followerId, otherResearcherId)).toEqual({
      following: false,
    });
  });
});

describe('getFollowStats — 프로필 표시용', () => {
  it('팔로워 수·팔로잉 수·내 팔로우 여부를 함께 준다', async () => {
    const stats = await getFollowStats(prisma, researcherId, followerId);
    expect(stats.followers).toBe(1);
    expect(stats.isFollowing).toBe(true);
    expect(stats.isSelf).toBe(false);
  });

  it('비로그인 뷰어는 isFollowing false (수치는 그대로 공개)', async () => {
    const stats = await getFollowStats(prisma, researcherId, null);
    expect(stats.followers).toBe(1);
    expect(stats.isFollowing).toBe(false);
  });

  it('본인 프로필이면 isSelf — 팔로우 버튼을 숨기는 근거', async () => {
    const stats = await getFollowStats(prisma, researcherId, researcherUserId);
    expect(stats.isSelf).toBe(true);
  });

  it('리서처가 남을 팔로우하면 그 계정의 팔로잉 수로 잡힌다', async () => {
    await followResearcher(prisma, researcherUserId, otherResearcherId);
    const stats = await getFollowStats(prisma, researcherId, null);
    expect(stats.following).toBe(1);
    await unfollowResearcher(prisma, researcherUserId, otherResearcherId);
  });

  it('없는 리서처는 0으로 응답 (404 처리는 화면이 담당)', async () => {
    expect(await getFollowStats(prisma, 'nope', followerId)).toMatchObject({
      followers: 0,
      isFollowing: false,
    });
  });
});

describe('새 예측 카드 알림', () => {
  it('게시 트랜잭션에서 팔로워에게만 알림이 생성된다', async () => {
    const reportId = await publishCard(researcherId, 'KRW-AAA', '팔로워 알림용 카드');

    const notis = await prisma.notification.findMany({
      where: { type: NEW_CARD_NOTIFICATION_TYPE },
    });
    expect(notis).toHaveLength(1);
    expect(notis[0].userId).toBe(followerId);
    expect(notis[0].title).toContain('따라갈 리서처');
    // 종목명은 종목 마스터 기준으로 정규화된 이름이 쓰인다 (KRW-AAA → AAA)
    expect(notis[0].body).toContain('AAA ▲ 상승 12%');
    expect(notis[0].link).toBe(`/report/${reportId}`);
    expect(notis[0].readAt).toBeNull();
  });

  it('팔로워가 없는 리서처의 게시는 알림을 만들지 않는다', async () => {
    await publishCard(otherResearcherId, 'KRW-BBB', '팔로워 없는 카드');
    const notis = await prisma.notification.findMany({
      where: { type: NEW_CARD_NOTIFICATION_TYPE },
    });
    expect(notis).toHaveLength(1); // 위 테스트의 1건 그대로
  });
});

describe('getFollowedResearcherCards — 리더보드 모아보기', () => {
  it('팔로우한 리서처의 판매 중 카드만 최신순으로', async () => {
    const ids = await getFollowedResearcherIds(prisma, followerId);
    expect(ids).toEqual([researcherId]);

    const cards = await getFollowedResearcherCards(prisma, ids, 10, PUBLISH_NOW);
    expect(cards).toHaveLength(1);
    expect(cards[0].researcherId).toBe(researcherId);
    expect(cards[0].title).toBe('팔로워 알림용 카드');
  });

  it('팔로우가 없으면 빈 목록 (쿼리도 돌지 않는다)', async () => {
    expect(await getFollowedResearcherCards(prisma, [], 10, PUBLISH_NOW)).toEqual([]);
  });

  it('시한이 지난 카드는 빠진다 (구매 가능 기준 공유)', async () => {
    const after = new Date('2026-08-02T00:00:00Z');
    expect(
      await getFollowedResearcherCards(prisma, [researcherId], 10, after),
    ).toEqual([]);
  });

});

describe('MY 화면 목록 — getFollowingList / getFollowerList', () => {
  it('팔로잉 목록은 리서처 표시 정보와 팔로우 시작일을 함께 준다', async () => {
    const list = await getFollowingList(prisma, followerId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ researcherId, name: '따라갈 리서처', tier: 'BRONZE' });
    expect(list[0].followedAt).toBeInstanceOf(Date);
  });

  it('팔로워 목록은 필명이 없으면 이메일 대신 익명 라벨을 쓴다 (구매자 신원 보호)', async () => {
    const list = await getFollowerList(prisma, researcherId);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('이름을 밝히지 않은 이용자');
    expect(JSON.stringify(list)).not.toContain('f@f.io');
  });

  it('리서처가 아닌 이용자는 팔로워가 구조적으로 존재하지 않는다', async () => {
    // Follow는 사용자 → 리서처 프로필이라, 프로필이 없으면 대상 자체가 될 수 없다
    expect(await getFollowerList(prisma, 'not-a-researcher')).toEqual([]);
  });
});
