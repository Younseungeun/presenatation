import type { PrismaClient } from '@prisma/client';
import { ASSET_CLASSES, type AssetClass } from '@/domain/constants';
import { auditOp } from './auditLog';

// **자동 판정을 사람이 멈춘다** (2026-08-15).
//
// ── 왜 배치 락이 아니라 별도 플래그인가 ──────────────────────
// 배치 락(`withBatchLock`)은 **프로세스가 끝나면 풀리는 임시 자물쇠**다. 롤백은
// "멈춘다 → 무엇이 지워지는지 확인한다 → 실행한다 → **사람이 시세를 확인한 뒤**
// 다시 연다"의 절차이고, 그 사이에 사람이 자리를 비울 수도 며칠이 걸릴 수도 있다.
// 프로세스 수명에 묶인 락은 그 절차를 못 버틴다.
//
// ── 왜 멈춰야 하는가 ─────────────────────────────────────────
// 시세 오류로 100장을 되돌려도 **1.1초 뒤 배치가 깨어나 같은 고장 난 데이터로 다시
// 오판정한다.** 되돌리기가 무의미해지는 것이 아니라 **되돌릴수록 나빠진다** —
// 매번 알림이 나가고 구매자는 판정이 두 번 뒤집히는 것을 본다.
//
// ── 범위: 자산군 + 전역 두 단계 ──────────────────────────────
// 시세 사고는 보통 **공급자 단위**로 터지고, 공급자의 장애 반경은 자산군과 거의
// 일치한다(국내 = 금융위·KIS / 미국 = 나스닥·KIS / 코인 = 업비트).
//
//  · **종목별은 두지 않는다** — 100장짜리 사고에서 종목이 30개면 30번 걸어야 하고,
//    거는 동안 나머지가 계속 오염된다. 정확한 대신 사고 때 쓸 수 없다
//  · **전역만 두지도 않는다** — 국내 공급자가 틀렸는데 코인 판정까지 멈추면 그쪽
//    카드가 이월되고, 이월은 14일 상한에 닿으면 **전액 환불**로 끝난다.
//    사고를 고치는 것이 아니라 옆으로 옮기는 셈이다
//
// ── 사람이 건 정지는 사람만 푼다. 시스템이 건 정지는 다르다 (2026-08-15) ──
// 위 문단은 원래 "시간이 지났다고 자동으로 풀리지 않는다"였고, **사람이 건 정지에
// 대해서는 지금도 그대로다** — 자동 해제는 "공급자가 고쳐졌다"를 시스템이 안다고
// 가정하는 것인데, 그걸 아는 방법이 없어서 애초에 사람이 멈춘 것이다.
//
// 그런데 교차검증이 **스스로 거는 정지**가 생기면서 사정이 갈렸다. 그쪽은
// "두 소스가 다른 답을 냈다"는 **관측**이 근거이고, 그 관측은 **다시 할 수 있다.**
// 순간 단절로 멈춘 자산군이 운영자 휴가 때문에 며칠 서 있으면, 그동안 맞힌 카드까지
// 14일 상한에 닿아 전액 환불로 끝난다 — 정지가 리서처를 집단으로 벌하는 장치가 된다.
//
// 그래서 **누가 걸었는지를 기록하고**(AppSetting.updatedBy), 시스템이 건 것만
// 재관측으로 풀 수 있게 한다 (server/crossCheckRecovery).

const KEY_PREFIX = 'judgment.paused.';
const GLOBAL_KEY = `${KEY_PREFIX}ALL`;

/**
 * 시스템이 스스로 건 정지의 표식 (judgmentBatch의 대량 불일치 정지).
 * 사람이 건 정지와 갈라야 **자동 해제가 사람의 판단을 덮어쓰지 않는다.**
 */
export const SYSTEM_PAUSE_ACTOR = 'system:cross-check';

export interface PauseState {
  /** 전 자산군 정지 */
  global: boolean;
  /** 자산군별 정지 */
  byAssetClass: Partial<Record<AssetClass, boolean>>;
}

function keyFor(scope: AssetClass | 'ALL'): string {
  return `${KEY_PREFIX}${scope}`;
}

export async function getPauseState(prisma: PrismaClient): Promise<PauseState> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: KEY_PREFIX } },
    select: { key: true, value: true },
  });
  const on = new Set(rows.filter((r) => r.value === '1').map((r) => r.key));
  return {
    global: on.has(GLOBAL_KEY),
    byAssetClass: Object.fromEntries(
      ASSET_CLASSES.map((a) => [a, on.has(keyFor(a))]),
    ) as Partial<Record<AssetClass, boolean>>,
  };
}

/**
 * 이 자산군의 자동 판정이 멈춰 있는가 — **배치 진입부가 매 회차 묻는다.**
 * 자산군 스코프가 없는 호출(전 자산군 배치)은 전역 정지만 본다.
 *
 * ⚠ 스코프 없는 호출이 자산군별 정지를 **못 본다**는 것이 함정이었다 (2026-08-15).
 * 기동 따라잡기(catchUpOnBoot)와 `npm run batch:judge`가 스코프 없이 도는데,
 * 그러면 **정지해 둔 자산군이 재기동 한 번으로 그대로 판정된다** — 배포가 잦은
 * 시기에는 정지가 사실상 무력하다. 그 경로는 `pausedAssetClasses`로 대상에서
 * 걸러 내야 한다(judgmentBatch). 이 함수의 계약은 그대로 둔다 — 스코프를 준
 * 호출에게는 이 답이 맞고, 여기서 전 자산군을 보게 하면 코인 정지가 국내 판정을
 * 멈추는 반대 방향의 사고가 난다.
 */
export async function isJudgmentPaused(
  prisma: PrismaClient,
  assetClass?: AssetClass,
): Promise<boolean> {
  const keys = assetClass ? [GLOBAL_KEY, keyFor(assetClass)] : [GLOBAL_KEY];
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: keys } },
    select: { value: true },
  });
  return rows.some((r) => r.value === '1');
}

/**
 * 지금 멈춰 있는 자산군들 — **스코프 없는 배치가 대상에서 빼기 위해** 쓴다.
 * 전역 정지는 여기 담기지 않는다(그건 배치가 통째로 서는 별개의 상태다).
 */
export async function pausedAssetClasses(prisma: PrismaClient): Promise<Set<AssetClass>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: KEY_PREFIX }, value: '1' },
    select: { key: true },
  });
  const out = new Set<AssetClass>();
  for (const r of rows) {
    const scope = r.key.slice(KEY_PREFIX.length);
    if (scope !== 'ALL') out.add(scope as AssetClass);
  }
  return out;
}

/** 이 자산군의 정지를 **시스템이** 걸었는가 — 자동 해제 자격의 유일한 기준 */
export async function isSystemPaused(
  prisma: PrismaClient,
  assetClass: AssetClass,
): Promise<boolean> {
  const row = await prisma.appSetting.findUnique({
    where: { key: keyFor(assetClass) },
    select: { value: true, updatedBy: true },
  });
  return row?.value === '1' && row.updatedBy === SYSTEM_PAUSE_ACTOR;
}

/**
 * **시스템 정지일 때만 푼다 — 조건부 갱신** (2026-08-15, 외부 검토 F-4 ②).
 *
 * 탐침은 "시스템 정지인가"를 읽고 → 네트워크로 5장을 조회하고(수 초) → 해제를 쓴다.
 * 그 사이에 운영자가 **직접 정지를 걸면**, 앞의 읽기 결과를 믿고 쓰는 해제가
 * **사람의 판단을 조용히 덮어쓴다.** 실제로 일어날 수 있는 창이고(탐침이 수 초를 쓴다),
 * 결과가 심각하다 — 운영자는 자기가 멈춘 자산군이 다시 도는 것을 모른다.
 *
 * 그래서 갱신 조건에 `updatedBy`를 넣어 **원자적으로** 확인한다. 0행이면 그 사이에
 * 누가 손댄 것이므로 **탐침 결과를 버린다** — 다시 재는 것이 옳지, 이긴 쪽을 정하는
 * 문제가 아니다.
 */
export async function resumeIfSystemPaused(
  prisma: PrismaClient,
  assetClass: AssetClass,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  const key = keyFor(assetClass);
  const { count } = await prisma.appSetting.updateMany({
    where: { key, value: '1', updatedBy: SYSTEM_PAUSE_ACTOR },
    data: { value: '0', updatedBy: SYSTEM_PAUSE_ACTOR },
  });
  if (count === 0) return false;

  await auditOp(prisma, {
    actor: SYSTEM_PAUSE_ACTOR,
    actorType: 'OPERATOR',
    action: 'JUDGMENT_PAUSE_SET',
    targetType: 'JudgmentPause',
    targetId: assetClass,
    before: { paused: true },
    after: { paused: false },
    reason: reason.slice(0, 500),
    at: now,
  });
  return true;
}

/**
 * 멈추거나 다시 연다. **사유가 필수다** — 왜 멈췄는지 모르면 언제 풀어야 하는지도 모른다.
 * 변경은 감사 로그에 남는다(돈을 움직이지는 않지만 돈의 근거를 바꾸는 행위다).
 */
export async function setJudgmentPause(
  prisma: PrismaClient,
  input: {
    scope: AssetClass | 'ALL';
    paused: boolean;
    operatorUserId: string;
    reason: string;
  },
  now = new Date(),
): Promise<void> {
  const key = keyFor(input.scope);
  const before = await prisma.appSetting.findUnique({ where: { key } });
  const value = input.paused ? '1' : '0';

  await prisma.$transaction([
    prisma.appSetting.upsert({
      where: { key },
      create: { key, value, updatedBy: input.operatorUserId },
      update: { value, updatedBy: input.operatorUserId },
    }),
    auditOp(prisma, {
      actor: input.operatorUserId,
      actorType: 'OPERATOR',
      action: 'JUDGMENT_PAUSE_SET',
      targetType: 'JudgmentPause',
      targetId: input.scope,
      before: { paused: before?.value === '1' },
      after: { paused: input.paused },
      reason: input.reason.slice(0, 500),
      at: now,
    }),
  ]);
}
