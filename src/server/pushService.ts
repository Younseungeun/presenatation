import type { PrismaClient } from '@prisma/client';
import { hasDigits, pushCopyFor, shouldPush } from '@/domain/pushCopy';
import {
  createPushProviderFromEnv,
  type PushProvider,
  type PushTarget,
} from '@/infra/push/provider';

// 푸시 발송 — **인앱 알림이 진실이고 푸시는 그 사본이다.**
//
// ── 왜 알림을 만드는 자리에서 안 보내는가 ──────────────────────
// 알림 행은 판정·정산 트랜잭션 **안**에서 태어나고(judgmentWriter는 createMany 한 문장),
// 이 코드베이스는 트랜잭션 안의 I/O를 금지한다(noIoInTransaction). 근거는 실측이었다 —
// 트랜잭션이 길면 SQLite 쓰기 락이 잡혀 그동안 결제가 죽는다.
//
// 그렇다고 커밋 직후에 호출을 심으면 **호출처가 19곳**이고, 다음에 알림 종류를 추가하는
// 사람이 한 곳을 빠뜨린다. 그 사람을 막을 장치가 없다 — 판정 fan-out 시험이 잡아낸 것과
// 정확히 같은 모양의 함정이다.
//
// 그래서 **스윕**이다. 알림 행에 `pushedAt`을 비워 두면 스케줄러가 주워 간다.
// 새 알림 종류는 아무것도 안 해도 자동으로 따라온다 — 잊을 수가 없다.
// 대가는 최대 한 틱의 지연인데, 스케줄러가 자주 돌므로 실질적으로는 분 단위다.
//
// ── 시험에서는 절대 안 나간다 ──────────────────────────────────
// 2026-08-18에 실제로 겪었다: 테스트가 만든 가짜 알림 수십 건이 창업자 폰으로 나갔다.
// 원인은 vitest가 .env를 안 읽는데 **Prisma가 읽어서** 텔레그램 값이 살아난 것이었다.
// 푸시는 그보다 더 나쁘다 — 받는 사람이 운영자가 아니라 **이용자 전원**이다.
//
// 가드는 여기가 아니라 **fetch를 부르는 자리**(infra/push/fcm.ts)에 있다.
// 처음엔 이 스윕 안에 뒀는데 시험용 공급자까지 함께 막혀서 배달·정리 로직을
// 아예 시험할 수 없었다 — 가드가 검증을 막으면 가드가 맞는지도 알 수 없다.

/**
 * 한 번의 스윕이 처리할 최대 알림 수.
 *
 * @근거 설계 스윕은 매 틱 도는 항목이라 **한 회차가 틱을 독점하면 안 된다**. 200건이면
 * 최악(기기 2대 × FCM 왕복 ~200ms)에도 한 회차가 1분 안에 끝나 다음 틱을 막지 않는다.
 * 넘친 것은 사라지지 않고 다음 회차가 이어 받는다 — 오래된 것부터 집으므로 굶는 행이 없다.
 */
export const PUSH_SWEEP_LIMIT = 200;
/**
 * 이만큼 연속 실패하면 죽은 것으로 보고 지운다 (공급자가 gone이라고 말하면 즉시).
 *
 * @근거 설계 진짜 죽은 토큰은 공급자가 404로 알려 주므로 이 값이 맡는 것은 **판별이
 * 안 되는 실패**(401·429·5xx)뿐이다. 매 틱 도니 5회는 몇 분이면 쌓이는데, 그 정도로
 * 짧으면 몇 분짜리 공급자 장애에 전 이용자의 구독이 날아간다 — 그래서 실패는 **연속으로만**
 * 센다(성공 한 번에 registerPushSubscription이 0으로 되돌린다). 지워져도 앱을 다시 열면
 * 재등록되므로 대가는 알림 한 번을 놓치는 것이고, 반대쪽 대가(죽은 토큰이 영원히 남아
 * 발송마다 헛돎)는 스스로 안 사라진다.
 */
export const PUSH_MAX_FAILURES = 5;
/**
 * 이보다 오래된 알림은 푸시하지 않고 보낸 것으로 표시만 한다.
 *
 * @근거 설계 스케줄러가 멈췄다 살아나면 밀린 알림이 한꺼번에 울린다 — 어제 끝난 판정이
 * 오늘 새벽에 진동하면 이용자는 **알림을 통째로 끄고**, 그러면 계좌 변경 경고까지 함께
 * 사라진다. 6시간인 이유: 판정은 마감 +5분에 돌고 스케줄러 정지는 몇 분~한두 시간 단위라
 * (schedulerHealth의 문턱이 심박 2분·항목 30분) 정상 운영에서 6시간이 밀릴 일이 없다.
 * 반대로 반나절 이상 밀린 것은 이미 "지금 일어난 일"이 아니다. 인앱 알림함에는 그대로
 * 남으므로 정보가 사라지지는 않는다 — 사라지는 것은 진동뿐이다.
 */
export const PUSH_MAX_AGE_MS = 6 * 60 * 60_000;

let cached: PushProvider | null | undefined;
function provider(): PushProvider | null {
  if (cached === undefined) cached = createPushProviderFromEnv();
  return cached;
}
/** 시험이 공급자를 갈아끼운다 (null을 넣으면 "설정 안 됨" 상태를 재현) */
export function setPushProviderForTests(p: PushProvider | null | undefined): void {
  cached = p;
}

export interface RegisterPushInput {
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  label?: string;
}

/**
 * 기기 등록 — **같은 토큰이 다른 사람에게 넘어갈 수 있다.**
 * 폰을 중고로 팔거나 가족이 로그인을 바꾸면 같은 기기 토큰이 다른 계정으로 온다.
 * 토큰을 유일값으로 두고 userId를 덮어쓰는 이유가 이것이다 —
 * 안 그러면 **전 주인의 알림이 새 주인 폰에 뜬다.**
 */
export async function registerPushSubscription(
  prisma: PrismaClient,
  input: RegisterPushInput,
  now = new Date(),
) {
  const token = input.token.trim();
  if (!token) throw new Error('푸시 토큰이 비어 있습니다');
  return prisma.pushSubscription.upsert({
    where: { token },
    create: {
      userId: input.userId,
      token,
      platform: input.platform,
      label: input.label ?? null,
      lastSeenAt: now,
    },
    update: {
      userId: input.userId,
      platform: input.platform,
      label: input.label ?? null,
      lastSeenAt: now,
      failCount: 0, // 다시 나타났으면 살아 있는 것이다
    },
  });
}

/** 로그아웃·기기 삭제 시. 없는 토큰을 지워도 오류로 만들지 않는다 (멱등) */
export async function unregisterPushSubscription(
  prisma: PrismaClient,
  token: string,
): Promise<number> {
  const { count } = await prisma.pushSubscription.deleteMany({ where: { token } });
  return count;
}

/** 설정 화면용 — 내 기기 목록 (토큰은 절대 내보내지 않는다) */
export async function listPushSubscriptions(prisma: PrismaClient, userId: string) {
  const rows = await prisma.pushSubscription.findMany({
    where: { userId },
    orderBy: { lastSeenAt: 'desc' },
  });
  return rows.map((r) => ({
    id: r.id,
    platform: r.platform,
    label: r.label,
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt,
  }));
}

export interface PushSweepResult {
  /** 푸시를 시도한 알림 수 */
  attempted: number;
  /** 실제로 한 대 이상 배달된 알림 수 */
  delivered: number;
  /** 구독이 없어 그냥 표시만 한 알림 수 */
  noDevice: number;
  /** 너무 오래돼 보내지 않고 표시만 한 알림 수 */
  tooOld: number;
  /** 지운 죽은 구독 수 */
  pruned: number;
}

/**
 * 아직 안 보낸 알림을 훑어 푸시로 내보낸다. **여러 번 돌아도 안전하다** —
 * `pushedAt`이 찍힌 것은 다시 집지 않으므로 같은 알림이 두 번 울리지 않는다.
 *
 * 공급자가 없으면(설정 전) 아무것도 보내지 않고 **표시도 하지 않는다** — 나중에
 * 파이어베이스를 붙이는 날, 그날 이후 알림부터 나가게 하려면 밀린 것을 남겨 둬야 하는데,
 * 그때 한꺼번에 쏟아지면 곤란하므로 나이 제한(PUSH_MAX_AGE_MS)이 알아서 걸러 준다.
 */
export async function flushPendingPush(
  prisma: PrismaClient,
  now = new Date(),
): Promise<PushSweepResult> {
  const out: PushSweepResult = { attempted: 0, delivered: 0, noDevice: 0, tooOld: 0, pruned: 0 };
  const p = provider();
  if (!p) return out;

  const pending = await prisma.notification.findMany({
    where: { pushedAt: null },
    orderBy: { createdAt: 'asc' },
    take: PUSH_SWEEP_LIMIT,
    select: { id: true, userId: true, type: true, link: true, createdAt: true },
  });
  if (pending.length === 0) return out;

  // 보낼 필요가 없는 것들을 먼저 걸러 **표시만** 한다. 남겨 두면 스윕이 매번 같은 행을
  // 다시 집어 들고, 그러면 진짜 보낼 것이 뒤로 밀린다
  const skip = pending.filter(
    (n) =>
      !shouldPush(n.type) || now.getTime() - n.createdAt.getTime() > PUSH_MAX_AGE_MS,
  );
  out.tooOld = skip.filter((n) => shouldPush(n.type)).length;
  if (skip.length > 0) {
    await prisma.notification.updateMany({
      where: { id: { in: skip.map((n) => n.id) } },
      data: { pushedAt: now },
    });
  }
  const live = pending.filter((n) => !skip.includes(n));
  if (live.length === 0) return out;

  const subs = await prisma.pushSubscription.findMany({
    where: { userId: { in: [...new Set(live.map((n) => n.userId))] } },
  });
  const byUser = new Map<string, typeof subs>();
  for (const s of subs) {
    const list = byUser.get(s.userId) ?? [];
    list.push(s);
    byUser.set(s.userId, list);
  }

  const goneIds = new Set<string>();
  const failedIds = new Set<string>();
  const pushedIds: string[] = [];

  for (const n of live) {
    const targets: PushTarget[] = (byUser.get(n.userId) ?? []).map((s) => ({
      token: s.token,
      platform: s.platform,
      subscriptionId: s.id,
    }));
    // 기기가 없어도 **보낸 것으로 표시한다** — 앱을 안 깐 사람의 알림이 큐에 영원히
    // 남으면 스윕이 매번 같은 행을 헛되이 훑는다. 인앱 알림함에는 그대로 있다
    if (targets.length === 0) {
      out.noDevice += 1;
      pushedIds.push(n.id);
      continue;
    }
    out.attempted += 1;
    pushedIds.push(n.id);

    const copy = pushCopyFor(n.type);
    const results = await p.send(targets, {
      title: copy.title,
      body: copy.body,
      link: n.link,
      urgent: copy.urgent,
    });
    if (results.some((r) => r.ok)) out.delivered += 1;
    for (const r of results) {
      if (r.gone) goneIds.add(r.subscriptionId);
      else if (!r.ok) failedIds.add(r.subscriptionId);
    }
  }

  if (pushedIds.length > 0) {
    await prisma.notification.updateMany({
      where: { id: { in: pushedIds } },
      data: { pushedAt: now },
    });
  }
  // 죽었다고 답한 구독은 즉시 삭제. 일시 실패는 세어 두고, 계속 실패하면 그때 지운다 —
  // 공급자 장애 한 번에 전 이용자의 구독을 날리면 복구할 방법이 재등록뿐이다
  if (goneIds.size > 0) {
    const { count } = await prisma.pushSubscription.deleteMany({
      where: { id: { in: [...goneIds] } },
    });
    out.pruned += count;
  }
  if (failedIds.size > 0) {
    await prisma.pushSubscription.updateMany({
      where: { id: { in: [...failedIds] } },
      data: { failCount: { increment: 1 } },
    });
    const { count } = await prisma.pushSubscription.deleteMany({
      where: { id: { in: [...failedIds] }, failCount: { gte: PUSH_MAX_FAILURES } },
    });
    out.pruned += count;
  }
  return out;
}

/**
 * 새 문구를 추가할 때 숫자가 섞이지 않았는지 확인하는 헬퍼 — 시험이 쓴다.
 * (금액·계좌 뒷자리가 잠금화면에 뜨는 것을 막는 규칙. 근거는 domain/pushCopy.ts 머리 주석)
 */
export { hasDigits };
