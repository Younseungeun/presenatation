import { Prisma, type PrismaClient } from '@prisma/client';

// 팔로우 — 사용자가 리서처를 구독한다.
// 목적은 두 가지: ① 새 예측 카드가 게시되면 알림을 받는다 ② 리더보드에서
// 팔로우한 리서처의 카드만 모아 본다.
//
// 단방향이다(맞팔 개념 없음). 팔로우는 "이 사람의 다음 예측을 보겠다"는 선언이지
// 사교 관계가 아니라서, 승인·차단·비공개 같은 절차를 두지 않는다.
// 자기 자신(같은 계정의 리서처 프로필)은 팔로우할 수 없다 — 자기 알림·자기 카드
// 모아보기는 MY가 이미 담당한다.

export class FollowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FollowError';
  }
}

/** 팔로우한 리서처의 새 카드 알림 종류 */
export const NEW_CARD_NOTIFICATION_TYPE = 'FOLLOWED_NEW_CARD';

async function assertFollowable(
  prisma: PrismaClient,
  followerId: string,
  researcherId: string,
): Promise<void> {
  const researcher = await prisma.researcherProfile.findUnique({
    where: { id: researcherId },
    select: { userId: true },
  });
  if (!researcher) throw new FollowError('존재하지 않는 리서처입니다');
  if (researcher.userId === followerId) {
    throw new FollowError('자기 자신은 팔로우할 수 없습니다');
  }
}

/**
 * 팔로우. 이미 팔로우 중이면 조용히 성공한다 —
 * 버튼 연타·중복 요청이 에러로 보이지 않도록 (결과 상태만 정확하면 된다).
 */
export async function followResearcher(
  prisma: PrismaClient,
  followerId: string,
  researcherId: string,
): Promise<{ following: true }> {
  await assertFollowable(prisma, followerId, researcherId);
  try {
    await prisma.follow.create({ data: { followerId, researcherId } });
  } catch (e) {
    // 유니크 위반 = 이미 팔로우 중 (동시 요청 포함)
    const duplicate =
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
    if (!duplicate) throw e;
  }
  return { following: true };
}

/** 언팔로우. 팔로우 중이 아니어도 조용히 성공한다 */
export async function unfollowResearcher(
  prisma: PrismaClient,
  followerId: string,
  researcherId: string,
): Promise<{ following: false }> {
  await prisma.follow.deleteMany({ where: { followerId, researcherId } });
  return { following: false };
}

export interface FollowStats {
  /** 이 리서처를 팔로우하는 사람 수 */
  followers: number;
  /** 이 리서처(계정)가 팔로우하는 리서처 수 */
  following: number;
  /** 보는 사람이 팔로우 중인지 (비로그인·본인이면 false) */
  isFollowing: boolean;
  /** 본인 프로필인지 — 팔로우 버튼을 숨기는 근거 */
  isSelf: boolean;
}

/** 프로필 화면용 팔로우 요약 */
export async function getFollowStats(
  prisma: PrismaClient,
  researcherId: string,
  viewerUserId: string | null,
): Promise<FollowStats> {
  const researcher = await prisma.researcherProfile.findUnique({
    where: { id: researcherId },
    select: { userId: true },
  });
  if (!researcher) {
    return { followers: 0, following: 0, isFollowing: false, isSelf: false };
  }

  const [followers, following, mine] = await Promise.all([
    prisma.follow.count({ where: { researcherId } }),
    // 리서처도 한 사람이라 남을 팔로우할 수 있다 — 그 계정 기준으로 센다
    prisma.follow.count({ where: { followerId: researcher.userId } }),
    viewerUserId
      ? prisma.follow.count({ where: { followerId: viewerUserId, researcherId } })
      : Promise.resolve(0),
  ]);

  return {
    followers,
    following,
    isFollowing: mine > 0,
    isSelf: viewerUserId !== null && viewerUserId === researcher.userId,
  };
}

/** 내가 팔로우한 리서처 id 목록 (리더보드 필터·알림 대상 계산용) */
export async function getFollowedResearcherIds(
  prisma: PrismaClient,
  followerId: string,
): Promise<string[]> {
  const rows = await prisma.follow.findMany({
    where: { followerId },
    select: { researcherId: true },
  });
  return rows.map((r) => r.researcherId);
}

/** 내가 팔로우한 리서처 수 (MY·요약 표시용) */
export function countFollowing(prisma: PrismaClient, followerId: string): Promise<number> {
  return prisma.follow.count({ where: { followerId } });
}

export interface FollowingRow {
  researcherId: string;
  name: string;
  tier: string;
  careerBadge: string | null;
  followedAt: Date;
}

/** 내가 팔로우한 리서처 목록 — MY '내 구매'에서 본다 (최근 팔로우 순) */
export async function getFollowingList(
  prisma: PrismaClient,
  followerId: string,
): Promise<FollowingRow[]> {
  const rows = await prisma.follow.findMany({
    where: { followerId },
    orderBy: { createdAt: 'desc' },
    include: {
      researcher: {
        select: {
          id: true,
          tier: true,
          careerBadge: true,
          user: { select: { penName: true, email: true } },
        },
      },
    },
  });
  return rows.map((f) => ({
    researcherId: f.researcher.id,
    // 리서처는 공개 활동 주체라 필명이 없으면 계정 이메일이 공개 표시명이다(기존 화면과 동일)
    name: f.researcher.user.penName ?? f.researcher.user.email,
    tier: f.researcher.tier,
    careerBadge: f.researcher.careerBadge,
    followedAt: f.createdAt,
  }));
}

export interface FollowerRow {
  /** 표시 이름 — 필명이 없으면 이메일 대신 익명 라벨 */
  name: string;
  followedAt: Date;
}

/**
 * 나를 팔로우한 사람 목록 — MY '내 리서치'에서 본다.
 * 팔로워는 리서처와 달리 공개 활동 주체가 아니다. 필명을 설정하지 않았다면
 * 이메일을 노출하지 않고 익명 라벨로 보여준다 (구매자 신원 보호).
 */
export async function getFollowerList(
  prisma: PrismaClient,
  researcherId: string,
): Promise<FollowerRow[]> {
  const rows = await prisma.follow.findMany({
    where: { researcherId },
    orderBy: { createdAt: 'desc' },
    include: { follower: { select: { penName: true } } },
  });
  return rows.map((f) => ({
    name: f.follower.penName ?? '이름을 밝히지 않은 이용자',
    followedAt: f.createdAt,
  }));
}

/**
 * 새 예측 카드 게시 알림 write 목록.
 * 게시 트랜잭션 안에서 함께 실행된다 — 게시는 됐는데 알림만 빠지는 상태를 만들지 않는다.
 * 팔로워가 없으면 빈 배열이라 트랜잭션 비용도 없다.
 */
export async function buildNewCardNotificationWrites(
  prisma: PrismaClient,
  input: {
    researcherId: string;
    researcherName: string;
    reportId: string;
    reportTitle: string;
    assetName: string;
    direction: string;
    sizeLabel: string;
  },
  now = new Date(),
) {
  const followers = await prisma.follow.findMany({
    where: { researcherId: input.researcherId },
    select: { followerId: true },
  });

  const dir = input.direction === 'UP' ? '▲ 상승' : '▼ 하락';
  return followers.map((f) =>
    prisma.notification.create({
      data: {
        userId: f.followerId,
        type: NEW_CARD_NOTIFICATION_TYPE,
        title: `${input.researcherName}님의 새 예측 카드`,
        body: `${input.assetName} ${dir} ${input.sizeLabel} · ${input.reportTitle}`,
        link: `/report/${input.reportId}`,
        createdAt: now,
      },
    }),
  );
}
