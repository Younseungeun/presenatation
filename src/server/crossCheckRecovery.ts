import type { PrismaClient } from '@prisma/client';
import type { AssetClass } from '@/domain/constants';
import { resolveCrossCheckMode, type CrossCheckMode } from '@/domain/crossCheck';
import type { ProviderRegistry } from '@/domain/marketData';
import { ProviderUnavailableError, runJudgmentFromRegistry } from '@/domain/judgmentPipeline';
import { JudgmentDisagreementError } from '@/domain/crossCheck';
import { memoizeRegistry } from '@/infra/marketData/memoRegistry';
import { toJudgeableCard } from './cardMapper';
import { auditOp } from './auditLog';
import { isSystemPaused, resumeIfSystemPaused, SYSTEM_PAUSE_ACTOR } from './judgmentPause';

// **시스템이 스스로 건 정지를 재관측으로 푼다** (2026-08-15, 외부 검토 D-4).
//
// ── 왜 자동 해제가 필요한가 ─────────────────────────────────────────
// 완전 수동 해제는 **단일 고장점**이다. 순간 단절로 멈춘 자산군이 운영자 휴가 때문에
// 며칠 서 있으면, 그동안 **맞힌 카드까지 14일 상한에 닿아 전액 환불로 끝난다.**
// 정지가 구매자를 보호하는 장치에서 리서처를 집단으로 벌하는 장치로 바뀐다.
//
// ── 검토의 제안에 있던 결함 ─────────────────────────────────────────
// 검토는 "정지 후 N회 배치 동안 불일치율이 0%로 돌아오면 자동 해제"를 제안했는데,
// 그대로는 **성립하지 않는다**: 정지 중에는 판정 배치가 진입부에서 돌아가므로
// **불일치율을 관측할 기회 자체가 없다.** 0%는 "괜찮아졌다"가 아니라 "아무것도 안 쟀다"다.
//
// 그래서 **관측을 따로 만든다** — 정지 중에도 도는 **탐침(probe)**이다:
// 판정 대상 몇 장을 골라 파이프라인을 `enforce`로 돌리되 **아무것도 쓰지 않는다.**
// 결론이 전부 일치하면 소스가 돌아온 것이므로 정지를 푼다.
//
// ── 사람이 건 정지는 건드리지 않는다 ────────────────────────────────
// 자격은 `AppSetting.updatedBy === SYSTEM_PAUSE_ACTOR` 하나다. 사람이 "이 소스는
// 믿을 수 없다"고 판단해 멈춘 것을 기계가 "지금 보니 맞던데요"로 뒤집으면 안 된다 —
// 사람은 배치가 모르는 것(공급자 공지·거래소 장애 발표)을 보고 멈췄을 수 있다.
//
// ── 검토의 하드락 조건 하나는 뒤집었다 ──────────────────────────────
// 검토는 "24시간 내 14일 상한에 닿는 카드가 있으면 자동 해제를 중단하고 인력 대기"를
// 제안했는데 **방향이 거꾸로다.** 상한이 임박한 카드가 있다는 것은 자동 해제를 막을
// 이유가 아니라 **서둘러야 할 이유**다 — 막으면 그 카드는 확정적으로 전액 환불로 끝난다.
// 그 상황에서 필요한 것은 정지 유지가 아니라 **알림의 격상**이다.

/** 탐침이 한 번에 확인하는 카드 수 — 적을수록 싸고, 많을수록 확신이 는다 */
export const PROBE_SAMPLE_SIZE = 5;

/**
 * 탐침 재시도 간격(분) — **실패할수록 뒤로 미룬다.**
 *
 * ── 이 값이 붙기 전의 결함 (2026-08-15, 외부 검토가 파냈다) ──────────
 * 검토는 "배치가 1분마다 도니 6분 만에 자동 재개를 포기한다"고 지적했다.
 * **전제는 틀렸다** — 판정 배치는 `enqueueDaily`라 자산군당 **하루 한 번** 돈다.
 *
 * 그런데 그 사실이 결함을 **반대 방향으로** 드러냈다. 탐침을 판정 경로 안에 두면
 * 관측도 하루 한 번이라:
 *  · 10분짜리 순간 단절로 멈춘 자산군이 **꼬박 하루를 서 있는다**
 *  · 6회 실패에 닿는 데 **6일**이 걸린다 — 그동안 카드는 14일 상한을 향해 간다
 * 자동 회복이 흡수해야 하는 장애의 시간 눈금(10~30분)과 관측 주기(24시간)가
 * 두 자릿수만큼 어긋나 있었다. **탐침을 판정 일정에서 떼어 낸 이유가 이것이다.**
 *
 * ── 눈금 (검토 제안을 그대로 채택) ──────────────────────────────────
 * 0 → 2 → 4 → 8 → 16 → 32분. 누적 62분이라 30분 안팎의 공급자 일시 장애를 덮으면서
 * 호출 폭주는 나지 않는다. 스케줄러 틱이 1분이므로 이 눈금이 실제 주기가 된다.
 *
 * 마지막 눈금을 반복하지 않는 이유: 6회에서 **자동 재개를 포기**하기 때문이다
 * (PROBE_MAX_FAILURES). 그 뒤로는 두드릴수록 개입만 늦어진다.
 */
export const PROBE_BACKOFF_MIN = [0, 2, 4, 8, 16, 32] as const;

/**
 * **자동 회복이 끝까지 갈 수 있는 시간** = 백오프 눈금의 합 (62분).
 * 상한 유예의 길이가 이 값인 이유는 아래 `PAUSE_GRACE_MS` 주석에 있다.
 */
export const PROBE_TOTAL_WINDOW_MS =
  PROBE_BACKOFF_MIN.reduce<number>((a, b) => a + b, 0) * 60_000;

/**
 * **막 걸린 시스템 정지는 14일 상한을 잠깐 미룬다** (2026-08-15, 외부 검토 F-4 ①).
 *
 * ── 검토가 짚은 경합 ────────────────────────────────────────────────
 * 카드가 시한 후 13.9일인데 소스가 파손돼 정지가 걸린다. 그 직후 상한 배치가 돌아
 * **전액 환불로 닫는다.** 2분 뒤 탐침이 성공해 소스가 돌아오지만 이미 늦었다 —
 * 정상 적중할 수 있었던 카드가 순간 장애 하나로 무판정으로 끝난다.
 *
 * ── 그런데 "정지 중 상한 유예"를 통째로 받으면 안 된다 ──────────────
 * 24차에 정지 스위치가 만든 결함이 정확히 그것이었다: 사람이 건 정지가 길어지는 동안
 * 카드가 **환불도 못 받고 묶였다.** 상한은 판정이 아니라 구매자와의 약속이라,
 * 사람이 언제 풀지 모르는 정지에 약속을 매달 수 없다.
 *
 * ── 그래서 유예의 길이를 "자동 회복이 끝까지 갈 수 있는 시간"으로 못 박는다 ──
 * 시스템이 건 정지에는 **끝이 정해져 있다** — 탐침이 6회 실패하면 하드락이고,
 * 거기까지가 62분이다(PROBE_TOTAL_WINDOW_MS). 그 시간만 미루면:
 *  · 순간 장애로 상한이 헛발동하는 일이 사라진다
 *  · 구매자 약속은 14일 + 1시간으로, 사실상 그대로다
 *  · 하드락에 닿는 순간 유예가 끝나 상한이 즉시 집행된다 — 사람을 기다리지 않는다
 * **사람이 건 정지에는 유예가 없다** (끝이 정해져 있지 않으므로).
 */
export const PAUSE_GRACE_MS = PROBE_TOTAL_WINDOW_MS;

/**
 * 이 자산군의 상한 집행을 지금 미뤄야 하는가 — **시스템 정지가 아직 젊을 때만** true.
 * (judgmentBatch의 정지 중 상한 스윕이 카드마다 묻는다)
 */
export async function shouldDelayHardCap(
  prisma: PrismaClient,
  assetClass: AssetClass,
  now: Date,
): Promise<boolean> {
  // 사람이 건 정지에는 유예가 없다 — 끝이 정해져 있지 않으므로
  if (!(await isSystemPaused(prisma, assetClass))) return false;
  // **정지가 시작된 시각은 우리가 적은 값을 쓴다** (AppSetting.updatedAt이 아니라).
  // 그 칸은 DB가 붙이는 벽시계라 배치가 받는 `now`와 다른 시계를 보게 되고,
  // 재시도로 행이 갱신되면 값이 조용히 미래로 밀린다 — 유예가 매번 새로 시작된다
  const startedAt = await readPausedAt(prisma, assetClass);
  if (!startedAt) return false;
  if (now.getTime() - startedAt.getTime() >= PAUSE_GRACE_MS) return false;
  // 이미 자동 회복을 포기했으면 기다릴 것이 없다 — 상한을 그대로 집행한다
  const failures = await readFailures(prisma, assetClass);
  return failures < PROBE_MAX_FAILURES;
}

const NEXT_KEY_PREFIX = 'judgment.probeNextAt.';
const TARGET_KEY_PREFIX = 'judgment.probeTargets.';
const PAUSED_AT_KEY_PREFIX = 'judgment.probePausedAt.';

/**
 * **정지를 일으킨 카드들** — 탐침이 먼저 봐야 할 대상 (judgmentBatch가 적어 둔다).
 * 이것이 없으면 탐침은 "아무 카드나 5장"을 보고, 티커별 파손을 통과시킨다.
 */
export async function setProbeTargets(
  prisma: PrismaClient,
  assetClass: AssetClass,
  cardIds: string[],
): Promise<void> {
  const key = TARGET_KEY_PREFIX + assetClass;
  const value = JSON.stringify(cardIds.slice(0, PROBE_SAMPLE_SIZE));
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value, updatedBy: SYSTEM_PAUSE_ACTOR },
    update: { value, updatedBy: SYSTEM_PAUSE_ACTOR },
  });
}

async function readProbeTargets(
  prisma: PrismaClient,
  assetClass: AssetClass,
): Promise<string[]> {
  const row = await prisma.appSetting.findUnique({
    where: { key: TARGET_KEY_PREFIX + assetClass },
    select: { value: true },
  });
  if (!row?.value) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/** 실패 횟수 → 다음 탐침 시각 */
export function nextProbeAt(failures: number, now: Date): Date {
  const idx = Math.min(Math.max(failures, 0), PROBE_BACKOFF_MIN.length - 1);
  return new Date(now.getTime() + PROBE_BACKOFF_MIN[idx] * 60_000);
}

/**
 * 연속으로 이만큼 탐침이 실패하면 **자동 해제를 포기하고 사람을 기다린다**.
 *
 * 자동 해제의 전제는 "일시적 장애"인데, 이만큼 반복되면 그 전제가 틀린 것이다.
 * 계속 시도해 봐야 공급자 호출만 태우고, 무엇보다 **"곧 풀리겠지"라는 기대가
 * 운영자의 개입을 늦춘다.**
 */
export const PROBE_MAX_FAILURES = 6;

const FAIL_KEY_PREFIX = 'judgment.probeFailures.';

export interface ProbeResult {
  assetClass: AssetClass;
  /** 탐침이 확인한 카드 수 (0이면 확인할 카드가 없어 판단하지 않았다) */
  checked: number;
  disagreed: number;
  /** 정지를 풀었는가 */
  resumed: boolean;
  /** 자동 해제를 포기했는가 (사람만 풀 수 있는 상태) */
  hardLocked: boolean;
  failures: number;
  /** 공급자가 아예 응답하지 못한 카드 수 — 불일치와 처방이 다르다 */
  providerDown: number;
  /** 백오프 때문에 이번 틱에는 두드리지 않았다 — 실패가 아니다 */
  skipped: boolean;
}

/**
 * **자동 정지가 잦아지는 것 자체가 소스를 바꿀 신호다** (2026-08-15, 외부 검토 E-2).
 *
 * 자동 해제가 잘 도는 동안에는 아무도 아프지 않아서, **소스가 계속 흔들리고 있다는
 * 사실이 감사 로그 안에만 남는다.** 그러다 어느 날 자동 해제가 실패하면 그때야
 * "원래 자주 그랬다"를 알게 된다 — 계약을 다시 볼 근거는 그 전에 있어야 한다.
 *
 * 검토 제안대로 **빈도와 지속시간을 함께** 잰다. 어느 한쪽만으로는 두 가지 다른
 * 고장을 구별하지 못한다:
 *  · 잦지만 짧다 → 순간 지터. 엔드포인트·재시도 설정을 볼 일이다
 *  · 드물지만 길다 → 공급자의 복구 능력 부실. 계약을 볼 일이다
 *
 * 값은 30일 창이다(초안 — 실운영 데이터가 쌓이면 다시 잡는다).
 */
export const SOURCE_INSTABILITY = {
  WINDOW_DAYS: 30,
  /** 이 횟수를 넘으면 엔드포인트·2차 피드를 검토한다 */
  MAX_HALTS: 5,
  /** 30일 누적 정지 시간이 이보다 길면 공급사 교체를 검토한다 */
  MAX_TOTAL_MINUTES: 120,
  /**
   * 5분 미만에 풀린 것은 **네트워크 미세 지터로 보고 빈도에서 뺀다** (검토 제안).
   * 세지 않으면 지터 몇 번이 문턱을 채워 진짜 신호를 덮는다.
   */
  JITTER_MINUTES: 5,
} as const;

export interface HaltEpisode {
  assetClass: string;
  pausedAt: Date;
  resumedAt: Date | null;
  minutes: number | null;
}

/**
 * 최근 창에서 **시스템이 걸고 푼 정지**의 이력 (감사 로그에서 복원).
 * 사람이 건 정지는 세지 않는다 — 소스의 불안정을 재는 지표이기 때문이다.
 */
export async function recentHaltEpisodes(
  prisma: PrismaClient,
  now = new Date(),
): Promise<HaltEpisode[]> {
  const from = new Date(now.getTime() - SOURCE_INSTABILITY.WINDOW_DAYS * 86_400_000);
  const rows = await prisma.auditLog.findMany({
    where: { action: 'JUDGMENT_PAUSE_SET', actor: SYSTEM_PAUSE_ACTOR, at: { gte: from } },
    orderBy: { at: 'asc' },
    select: { targetId: true, targetType: true, at: true, after: true },
  });

  const open = new Map<string, Date>();
  const out: HaltEpisode[] = [];
  for (const r of rows) {
    const paused = (JSON.parse(r.after ?? '{}') as { paused?: boolean }).paused === true;
    if (paused) {
      // 이미 열린 episode가 있으면 그것을 유지한다 — 중복 정지는 한 사건이다
      if (!open.has(r.targetId)) open.set(r.targetId, r.at);
      continue;
    }
    const startedAt = open.get(r.targetId);
    if (!startedAt) continue; // 사람이 푼 것 — 시작이 시스템이 아니면 이 지표의 대상이 아니다
    open.delete(r.targetId);
    out.push({
      assetClass: r.targetId,
      pausedAt: startedAt,
      resumedAt: r.at,
      minutes: (r.at.getTime() - startedAt.getTime()) / 60_000,
    });
  }
  // 아직 안 풀린 정지도 싣는다 — **지금 서 있는 것이 가장 중요한 사실**이다
  for (const [assetClass, pausedAt] of open) {
    out.push({
      assetClass,
      pausedAt,
      resumedAt: null,
      minutes: (now.getTime() - pausedAt.getTime()) / 60_000,
    });
  }
  return out;
}

/** 소스가 바뀔 때가 됐는가 — 빈도·누적시간 둘 중 하나만 넘어도 신호다 */
export function sourceInstabilityVerdict(episodes: HaltEpisode[]): {
  counted: number;
  totalMinutes: number;
  overFrequency: boolean;
  overDuration: boolean;
} {
  // 지터(5분 미만)는 **빈도에서만** 뺀다 — 누적 시간에는 그대로 들어간다.
  // 짧아도 잦으면 총 정지 시간이 늘고, 그 시간만큼 판정이 밀리는 것은 사실이다
  const counted = episodes.filter(
    (e) => (e.minutes ?? 0) >= SOURCE_INSTABILITY.JITTER_MINUTES,
  ).length;
  const totalMinutes = episodes.reduce((acc, e) => acc + (e.minutes ?? 0), 0);
  return {
    counted,
    totalMinutes,
    overFrequency: counted >= SOURCE_INSTABILITY.MAX_HALTS,
    overDuration: totalMinutes >= SOURCE_INSTABILITY.MAX_TOTAL_MINUTES,
  };
}

/**
 * **정지 episode가 시작될 때 탐침 상태를 0으로 되돌린다** (judgmentBatch가 부른다).
 *
 * 없으면 실패 횟수가 episode를 넘어 이어진다: 지난달 사고에서 6회를 채운 자산군은
 * 오늘 새로 멈추는 순간 **탐침을 한 번도 못 돌리고 바로 "자동 재개 포기"**가 된다.
 * 실패 횟수가 재는 것은 "이번 장애가 일시적인가"이지 그 자산군의 전과가 아니다.
 */
export async function resetProbeState(
  prisma: PrismaClient,
  assetClass: AssetClass,
  now = new Date(),
): Promise<void> {
  const startKey = PAUSED_AT_KEY_PREFIX + assetClass;
  const startValue = String(now.getTime());
  await Promise.all([
    writeFailures(prisma, assetClass, 0),
    prisma.appSetting.deleteMany({ where: { key: NEXT_KEY_PREFIX + assetClass } }),
    // **지난 사고의 표적도 지운다.** 남겨 두면 이번 사고의 탐침이 **저번에 깨졌던
    // 카드**를 보게 되고, 그 카드는 이미 사람이 판정했거나 다른 종목이라 결과가
    // 이번 사고와 무관하다 — 엉뚱한 답으로 정지를 풀거나 붙잡는다
    prisma.appSetting.deleteMany({ where: { key: TARGET_KEY_PREFIX + assetClass } }),
    // **이 사고가 시작된 시각** — 상한 유예의 기준이다 (shouldDelayHardCap)
    prisma.appSetting.upsert({
      where: { key: startKey },
      create: { key: startKey, value: startValue, updatedBy: SYSTEM_PAUSE_ACTOR },
      update: { value: startValue, updatedBy: SYSTEM_PAUSE_ACTOR },
    }),
  ]);
}

async function readPausedAt(prisma: PrismaClient, assetClass: AssetClass): Promise<Date | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: PAUSED_AT_KEY_PREFIX + assetClass },
    select: { value: true },
  });
  const t = Number(row?.value);
  return Number.isFinite(t) && t > 0 ? new Date(t) : null;
}

async function readNextAt(prisma: PrismaClient, assetClass: AssetClass): Promise<Date | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: NEXT_KEY_PREFIX + assetClass },
    select: { value: true },
  });
  if (!row?.value) return null;
  const t = Number(row.value);
  return Number.isFinite(t) ? new Date(t) : null;
}

async function writeNextAt(
  prisma: PrismaClient,
  assetClass: AssetClass,
  at: Date,
): Promise<void> {
  const key = NEXT_KEY_PREFIX + assetClass;
  const value = String(at.getTime());
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value, updatedBy: SYSTEM_PAUSE_ACTOR },
    update: { value, updatedBy: SYSTEM_PAUSE_ACTOR },
  });
}

async function readFailures(prisma: PrismaClient, assetClass: AssetClass): Promise<number> {
  const row = await prisma.appSetting.findUnique({
    where: { key: FAIL_KEY_PREFIX + assetClass },
    select: { value: true },
  });
  return Number(row?.value ?? 0) || 0;
}

async function writeFailures(
  prisma: PrismaClient,
  assetClass: AssetClass,
  n: number,
): Promise<void> {
  const key = FAIL_KEY_PREFIX + assetClass;
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value: String(n), updatedBy: SYSTEM_PAUSE_ACTOR },
    update: { value: String(n), updatedBy: SYSTEM_PAUSE_ACTOR },
  });
}

/**
 * 정지된 자산군의 소스가 돌아왔는지 **써 보지 않고 확인**하고, 돌아왔으면 푼다.
 *
 * **아무것도 쓰지 않는 것이 이 함수의 계약이다** — 판정도, 정산도, 백오프도, 카드
 * 갱신도 없다. 쓰는 순간 "정지 중"이라는 상태가 거짓이 된다. 남기는 것은 실패
 * 횟수와 감사 로그뿐이다.
 */
export async function probeAndMaybeResume(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  assetClass: AssetClass,
  secondaryRegistry?: ProviderRegistry,
  now = new Date(),
  mode: CrossCheckMode = resolveCrossCheckMode(),
): Promise<ProbeResult> {
  const base: ProbeResult = {
    assetClass,
    checked: 0,
    disagreed: 0,
    resumed: false,
    hardLocked: false,
    failures: 0,
    providerDown: 0,
    skipped: false,
  };

  // **사람이 건 정지는 자격이 없다.** 사람은 배치가 모르는 것을 보고 멈췄을 수 있다
  if (!(await isSystemPaused(prisma, assetClass))) return base;

  const failures = await readFailures(prisma, assetClass);
  base.failures = failures;
  // 이미 포기한 상태 — 더 두드리지 않는다(공급자 호출만 태우고 개입을 늦춘다)
  if (failures >= PROBE_MAX_FAILURES) return { ...base, hardLocked: true };

  // **백오프.** 스케줄러 틱이 1분이라 이것이 없으면 매분 두드려 6분 만에 포기한다 —
  // 공급자의 일시 장애가 대개 10~30분인데 그보다 먼저 사람 손을 부르는 셈이다
  const dueAt = await readNextAt(prisma, assetClass);
  if (dueAt && now < dueAt) return { ...base, skipped: true };

  // 교차검증이 꺼져 있거나 두 번째 소스가 없으면 **관측할 방법이 없다.**
  // 그때는 자동으로 풀지 않는다 — 근거 없이 여는 것이 근거 없이 닫는 것보다 나쁘다
  if (mode === 'off' || !secondaryRegistry?.[assetClass]) return base;

  // ── **깨진 것을 골라 본다** (2026-08-15, 외부 검토 F-4 ③) ────────────────
  //
  // 처음에는 시한 도래 카드를 오래된 순으로 5장 뽑았는데, 두 곳이 틀렸다:
  //  ① 파손이 **특정 티커 파이프라인**에만 있으면 멀쩡한 5장이 뽑혀 전원 합의로
  //     통과하고, 깨진 티커는 그대로인 채 정지가 풀린다
  //  ② 더 나쁜 것 — 불일치 카드는 `manualJudgmentOnly`가 세워지므로 그 필터가
  //     **정지를 일으킨 바로 그 카드들을 구조적으로 제외**하고 있었다.
  //     탐침이 무엇이 고쳐졌는지 확인할 대상만 정확히 빼고 보고 있었던 셈이다
  //
  // 그래서 정지 시점에 **불일치 카드 id를 적어 두고** 그것을 먼저 본다.
  // `manualJudgmentOnly`를 무시해도 되는 이유는 **탐침이 쓰지 않기 때문**이다 —
  // 그 플래그가 막는 것은 자동 판정이지 관측이 아니다.
  const targetIds = await readProbeTargets(prisma, assetClass);
  const primaryTargets = targetIds.length
    ? await prisma.predictionCard.findMany({
        where: {
          id: { in: targetIds },
          judgment: null,
          report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
        },
        include: { report: { select: { publishedAt: true } } },
        take: PROBE_SAMPLE_SIZE,
      })
    : [];

  // 표적이 모자라면 일반 대기 카드로 채운다 — 표적이 이미 사람 손에 판정됐을 수 있다
  const fill =
    primaryTargets.length >= PROBE_SAMPLE_SIZE
      ? []
      : await prisma.predictionCard.findMany({
          where: {
            judgment: null,
            assetClass,
            deadline: { lte: now },
            manualJudgmentOnly: false,
            // **빈 배열이면 조건 자체를 넣지 않는다** — Prisma가 `NOT IN ()`을 만들어
            // 한 건도 안 잡는다. 표적이 없는 정지(사람이 건 것 등)에서 탐침이
            // 조용히 "확인할 카드 0장"이 되던 자리다
            ...(primaryTargets.length > 0
              ? { id: { notIn: primaryTargets.map((c) => c.id) } }
              : {}),
            report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
          },
          include: { report: { select: { publishedAt: true } } },
          orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
          take: PROBE_SAMPLE_SIZE - primaryTargets.length,
        });
  const cards = [...primaryTargets, ...fill];
  // 확인할 카드가 없으면 **판단하지 않는다.** "불일치 0건"이 여기서는 "괜찮다"가
  // 아니라 "안 쟀다"이고, 그것으로 정지를 푸는 것이 검토안의 결함이었다
  if (cards.length === 0) return base;

  const quotes = memoizeRegistry(registry);
  let disagreed = 0;
  let checked = 0;
  let providerDown = 0;
  for (const card of cards) {
    try {
      await runJudgmentFromRegistry(
        toJudgeableCard(card, card.report.publishedAt!),
        quotes,
        now,
        secondaryRegistry,
        'enforce', // 탐침은 언제나 강제 모드로 본다 — 결론이 갈리는지가 알고 싶은 전부다
      );
      checked++;
    } catch (e) {
      if (e instanceof JudgmentDisagreementError) {
        disagreed++;
        checked++;
        continue;
      }
      // **공급자가 응답하지 못하는 것도 실패로 센다** (2026-08-15, 외부 검토 F-1).
      //
      // 처음에는 "소스가 죽어 있으면 돌아왔다고 말할 수 없으니 판단 보류"로 뒀는데,
      // 그러면 **영원히 탐침만 돈다** — 실패 카운터가 안 올라 하드락에 못 닿고,
      // 판정이 멈춰 있으니 배치의 공급자 장애 알림도 나가지 않는다. 62분 동안
      // 응답이 없는 것은 지터가 아니라 장애이고, 그때 필요한 것은 계속 두드리는
      // 것이 아니라 **사람을 부르는 것**이다.
      if (e instanceof ProviderUnavailableError) providerDown++;
      // 이월(시한 미도래·데이터 미공개)은 세지 않는다 — 그건 소스의 상태가 아니다
    }
  }

  // 확인도 못 했고 공급자도 멀쩡했다면(전부 이월) 판단할 근거가 없다
  if (checked === 0 && providerDown === 0) return base;

  if (disagreed > 0 || providerDown > 0) {
    const next = failures + 1;
    await writeFailures(prisma, assetClass, next);
    await writeNextAt(prisma, assetClass, nextProbeAt(next, now));
    return {
      ...base,
      checked,
      disagreed,
      providerDown,
      failures: next,
      hardLocked: next >= PROBE_MAX_FAILURES,
    };
  }

  // 전부 합의했다 — 소스가 돌아왔다고 본다.
  //
  // **조건부 갱신을 쓴다** (F-4 ②): 위의 자격 검사부터 여기까지 네트워크로 수 초가
  // 흘렀고, 그 사이 운영자가 직접 정지를 걸었을 수 있다. 그때 이 해제가 나가면
  // 사람의 판단을 조용히 덮어쓴다. 0행이면 **탐침 결과를 버린다** — 이긴 쪽을
  // 정하는 문제가 아니라 다시 재야 하는 문제다.
  const resumed = await resumeIfSystemPaused(
    prisma,
    assetClass,
    `탐침 ${checked}장이 모두 두 소스에서 같은 결론 — 자동 판정을 재개합니다`,
    now,
  );
  if (!resumed) {
    console.warn(
      `${assetClass}: 탐침이 합의했지만 그 사이 정지 상태가 바뀌어 해제를 취소했습니다`,
    );
    return { ...base, checked, disagreed: 0 };
  }
  await writeFailures(prisma, assetClass, 0);
  await writeNextAt(prisma, assetClass, now); // 다음 정지는 즉시 첫 탐침부터 시작한다
  // **자동으로 열었다는 사실 자체가 기록이어야 한다** — 사람이 나중에 "누가 열었나"를
  // 물었을 때 답이 있어야 하고, 자동 해제가 잦아지면 그것이 곧 소스를 바꿀 근거다
  await auditOp(prisma, {
    actor: SYSTEM_PAUSE_ACTOR,
    actorType: 'OPERATOR',
    action: 'JUDGMENT_PAUSE_SET',
    targetType: 'JudgmentPauseAutoResume',
    targetId: assetClass,
    before: { paused: true },
    after: { paused: false, probedCards: checked },
    reason: '교차검증 탐침 전원 합의 — 일시 장애로 판단',
    at: now,
  });

  return { ...base, checked, disagreed: 0, resumed: true, failures: 0 };
}
