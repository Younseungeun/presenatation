import type { PrismaClient } from '@prisma/client';
import type { AssetClass } from '@/domain/constants';
import { SYSTEM_PAUSE_ACTOR } from './judgmentPause';

// **자동 회복의 상태를 한 덩어리로 둔다** (2026-08-15, 외부 검토 E-3).
//
// ── 왜 옮겼는가 ─────────────────────────────────────────────────────
// 이 상태는 AppSetting 키 **다섯 개**에 흩어져 있었다 (paused / probeFailures /
// probeNextAt / probeTargets / probePausedAt). 상태 기계를 키-값에 펼쳐 두면
// **불변식을 코드로 강제할 수 없다** — "하드락인데 다음 탐침 시각이 남아 있다",
// "표적은 있는데 정지가 아니다" 같은 조합이 타입 검사를 그대로 통과한다.
//
// 실제로 그 구조가 결함을 낳았다: 상한 유예의 기준 시각을 `AppSetting.updatedAt`으로
// 읽고 있었는데, 그 칸은 **행이 갱신될 때마다 미래로 밀려** 유예가 매번 새로
// 시작됐다. 값이 흩어져 있으니 "이 시각은 무엇의 시각인가"가 코드에 안 적혀 있었다.
//
// ── 판별 합집합(discriminated union)으로 둔다 ───────────────────────
// `status`가 정해지면 그 상태에서 **의미 있는 칸만** 존재한다. 하드락에는 다음 탐침
// 시각이 아예 없고(포기했으므로), 탐침 중에는 잠금 시각이 없다. 잘못된 조합을
// 만들려면 타입을 어겨야 한다.
//
// ── 정지 플래그(judgment.paused.*)는 옮기지 않았다 ──────────────────
// 그 값은 배치 진입부와 운영 콘솔이 매번 읽는 **관문**이고, 사람이 거는 정지도 같은
// 칸을 쓴다. 여기로 끌어오면 회복 기계가 사람의 정지까지 표현해야 해서 오히려
// 상태가 늘어난다. **관문은 플래그, 회복 절차는 이 객체** — 역할이 다르다.

const KEY_PREFIX = 'judgment.recovery.';

/** 회복 절차가 도는 중 — 탐침이 백오프를 타며 소스가 돌아왔는지 본다 */
export interface ProbingState {
  status: 'PROBING';
  /** 이 사고가 시작된 시각 (epoch ms) — 상한 유예의 기준 */
  pausedAt: number;
  /** 연속 실패 횟수 */
  failures: number;
  /** 이 시각 전에는 다시 두드리지 않는다 */
  nextProbeAt: number;
  /** 정지를 일으킨 카드들 — 탐침이 **이것부터** 본다 */
  targetCardIds: string[];
}

/** 자동 회복을 포기했다 — 사람이 풀어야 한다 */
export interface HardLockedState {
  status: 'HARD_LOCKED';
  pausedAt: number;
  /** 포기한 시각 — 여기서부터 운영자 대기 유예가 흐른다 */
  lockedAt: number;
  failures: number;
  /** 마지막 실패의 성질 — 알림이 운영자를 어디로 보낼지 정한다 */
  cause: 'MISMATCH' | 'PROVIDER_DOWN';
}

export type RecoveryState = ProbingState | HardLockedState;

function keyFor(assetClass: AssetClass): string {
  return KEY_PREFIX + assetClass;
}

export async function readRecovery(
  prisma: PrismaClient,
  assetClass: AssetClass,
): Promise<RecoveryState | null> {
  const row = await prisma.appSetting.findUnique({
    where: { key: keyFor(assetClass) },
    select: { value: true },
  });
  if (!row?.value) return null;
  try {
    const parsed = JSON.parse(row.value) as RecoveryState;
    // 형태가 어긋난 값은 **없는 것으로 본다** — 지어낸 상태로 도는 것보다
    // 회복이 처음부터 다시 시작하는 편이 안전하다
    if (parsed?.status !== 'PROBING' && parsed?.status !== 'HARD_LOCKED') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function writeRecovery(
  prisma: PrismaClient,
  assetClass: AssetClass,
  state: RecoveryState,
): Promise<void> {
  const key = keyFor(assetClass);
  const value = JSON.stringify(state);
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value, updatedBy: SYSTEM_PAUSE_ACTOR },
    update: { value, updatedBy: SYSTEM_PAUSE_ACTOR },
  });
}

/** 회복 절차를 끝낸다 (정지가 풀렸을 때) */
export async function clearRecovery(
  prisma: PrismaClient,
  assetClass: AssetClass,
): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: keyFor(assetClass) } });
}

/**
 * **탐침 표적을 티커별로 고르게 뽑는다** (2026-08-15, 외부 검토 E-2).
 *
 * 전에는 불일치 카드를 나온 순서대로 잘랐다. 배치가 시한 순으로 도니까 **같은
 * 종목이 앞자리를 독차지**하기 쉽고, 그러면 12건 중 10건이 삼성전자·2건이
 * SK하이닉스일 때 표적 5장이 전부 삼성전자가 된다. 그 상태로 전원 합의하면
 * **SK하이닉스 파이프라인이 깨진 채 정지가 풀린다.**
 *
 * 그래서 티커를 한 바퀴씩 돌며 뽑는다(라운드로빈). 서로 다른 티커가 먼저 채워지고,
 * 자리가 남으면 같은 티커의 두 번째 카드가 들어간다.
 */
export function selectProbeTargets(
  cards: { id: string; ticker: string }[],
  max: number,
): string[] {
  const byTicker = new Map<string, string[]>();
  for (const c of cards) {
    const list = byTicker.get(c.ticker);
    if (list) list.push(c.id);
    else byTicker.set(c.ticker, [c.id]);
  }
  const out: string[] = [];
  let round = 0;
  while (out.length < max) {
    let added = false;
    for (const ids of byTicker.values()) {
      if (round >= ids.length) continue;
      out.push(ids[round]);
      added = true;
      if (out.length >= max) break;
    }
    if (!added) break; // 모든 티커를 다 소진했다
    round += 1;
  }
  return out;
}
