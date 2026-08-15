import type { PrismaClient } from '@prisma/client';
import type { AssetClass } from '@/domain/constants';
import { resolveCrossCheckMode, type CrossCheckMode } from '@/domain/crossCheck';
import type { ProviderRegistry } from '@/domain/marketData';
import { runJudgmentFromRegistry } from '@/domain/judgmentPipeline';
import { JudgmentDisagreementError } from '@/domain/crossCheck';
import { memoizeRegistry } from '@/infra/marketData/memoRegistry';
import { toJudgeableCard } from './cardMapper';
import { auditOp } from './auditLog';
import { isSystemPaused, setJudgmentPause, SYSTEM_PAUSE_ACTOR } from './judgmentPause';

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
  };

  // **사람이 건 정지는 자격이 없다.** 사람은 배치가 모르는 것을 보고 멈췄을 수 있다
  if (!(await isSystemPaused(prisma, assetClass))) return base;

  const failures = await readFailures(prisma, assetClass);
  base.failures = failures;
  // 이미 포기한 상태 — 더 두드리지 않는다(공급자 호출만 태우고 개입을 늦춘다)
  if (failures >= PROBE_MAX_FAILURES) return { ...base, hardLocked: true };

  // 교차검증이 꺼져 있거나 두 번째 소스가 없으면 **관측할 방법이 없다.**
  // 그때는 자동으로 풀지 않는다 — 근거 없이 여는 것이 근거 없이 닫는 것보다 나쁘다
  if (mode === 'off' || !secondaryRegistry?.[assetClass]) return base;

  const cards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      assetClass,
      deadline: { lte: now },
      manualJudgmentOnly: false,
      report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
    },
    include: { report: { select: { publishedAt: true } } },
    orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    take: PROBE_SAMPLE_SIZE,
  });
  // 확인할 카드가 없으면 **판단하지 않는다.** "불일치 0건"이 여기서는 "괜찮다"가
  // 아니라 "안 쟀다"이고, 그것으로 정지를 푸는 것이 검토안의 결함이었다
  if (cards.length === 0) return base;

  const quotes = memoizeRegistry(registry);
  let disagreed = 0;
  let checked = 0;
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
      // 이월·공급자 장애는 **불일치가 아니다.** 소스가 죽어 있으면 "돌아왔다"고
      // 말할 수 없으므로 확인 횟수에도 넣지 않는다 (checked가 0으로 남아 판단 보류)
    }
  }

  if (checked === 0) return base;

  if (disagreed > 0) {
    const next = failures + 1;
    await writeFailures(prisma, assetClass, next);
    return {
      ...base,
      checked,
      disagreed,
      failures: next,
      hardLocked: next >= PROBE_MAX_FAILURES,
    };
  }

  // 전부 합의했다 — 소스가 돌아왔다고 본다
  await setJudgmentPause(
    prisma,
    {
      scope: assetClass,
      paused: false,
      operatorUserId: SYSTEM_PAUSE_ACTOR,
      reason: `탐침 ${checked}장이 모두 두 소스에서 같은 결론 — 자동 판정을 재개합니다`,
    },
    now,
  );
  await writeFailures(prisma, assetClass, 0);
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
