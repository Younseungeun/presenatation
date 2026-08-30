import type { PrismaClient } from '@prisma/client';
import type { AssetClass } from '@/domain/constants';
import { ASSET_CLASSES } from '@/domain/constants';
import type { SourceHealth, SlowAlertState } from '@/domain/sourceHealth';
import { decideSlowPersistAlert } from '@/domain/sourceHealth';
import { SLOW_ALERT_AFTER_MS, SLOW_GAP_RESET_MS } from '@/domain/quoteWatch';
import { notifyOperators } from './opsAlert';

// 자산군별 시세 소스 헬스를 AppSetting에 남긴다 — 판정 배치가 매 회차 끝에 도장을 찍고,
// 관리자 홈 띠지가 읽는다. **새로 시세를 부르지 않는다** — 이미 돈 회차의 결과를 접을 뿐.

const KEY = (assetClass: AssetClass) => `source.health.${assetClass}`;

export interface SourceHealthRecord {
  health: SourceHealth;
  /** 사람이 읽을 사유 한 줄 (예: "kis 43건 응답 없음") */
  detail: string;
  at: string;
}

export async function recordSourceHealth(
  prisma: PrismaClient,
  assetClass: AssetClass,
  health: SourceHealth,
  detail: string,
  now = new Date(),
): Promise<void> {
  const value = JSON.stringify({ health, detail, at: now.toISOString() } satisfies SourceHealthRecord);
  await prisma.appSetting.upsert({
    where: { key: KEY(assetClass) },
    update: { value },
    create: { key: KEY(assetClass), value },
  });
}

export async function readSourceHealth(
  prisma: PrismaClient,
): Promise<Partial<Record<AssetClass, SourceHealthRecord>>> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { in: ASSET_CLASSES.map(KEY) } },
    select: { key: true, value: true },
  });
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out: Partial<Record<AssetClass, SourceHealthRecord>> = {};
  for (const ac of ASSET_CLASSES) {
    const raw = byKey.get(KEY(ac));
    if (!raw) continue;
    try {
      out[ac] = JSON.parse(raw) as SourceHealthRecord;
    } catch {
      /* 깨진 값은 없는 것으로 — 헬스 표시가 화면을 죽이지 않는다 */
    }
  }
  return out;
}

// ── 호출량 과다 지연 → 헬스 stamp + 지속 알람 (B, 2026-08-30) ──────────────
//
// "지연"은 **원인 불문**이다 (2026-08-30 사용자 확정). 시세 API 호출이 호출량 과다로
// 밀리는 모든 경우 — 유의 종목 급증(감시 60-cap 초과)·결제 폭주(실시간 호출 밀림)·
// 프로세스 충돌(KIS 초당 한도 초과 거절) — 이 전부 같은 "지연"으로 접힌다. 근본 병목이
// 하나이기 때문이다: 모든 KIS 호출은 계정 단위 1.1초 직렬 큐(infra kisAuth.SharedGate)를
// 지나고, 호출량이 그 한도를 넘으면 원인과 무관하게 여기서 밀린다.
//
// 두 가지를 한다:
//   ① 띠지 stamp — 지연이면 slow / 감시가 정상 확인하면 ok / 근거 없으면 판단 안 함
//   ② 지연이 6시간(SLOW_ALERT_AFTER_MS) 연속되면 운영자 알람 (규모가 한도를 넘었다는 신호)
//
// **해제 권한은 감시 회차에만 있다.** 감시 갱신(noteQuoteRefreshHealth)은 전체 감시
// 목록을 보므로 ok/slow를 authoritatively 판단하지만, 결제·거절 신호(reportQuoteDelay)는
// "지금 이 순간 밀렸다"만 알 뿐이라 **올리기만** 한다. 순간 급등은 다음 감시 회차(≤2분)가
// 정상이면 저절로 풀리고, 구조적 과부하만 6시간을 버텨 알람에 닿는다.

const SLOW_KEY = (assetClass: AssetClass) => `source.slow.${assetClass}`;

/** 지연의 원인 — 알람 문구에만 쓴다(신호는 하나로 통합) */
export type QuoteDelayCause = 'WATCH_CAP' | 'PAYMENT_SURGE' | 'RATE_LIMIT';
const CAUSE_LABEL: Record<QuoteDelayCause, string> = {
  WATCH_CAP: '유의 종목이 많아 장중 감시가 회차 상한(60)을 넘고 있습니다',
  PAYMENT_SURGE: '결제가 몰려 실시간 시세 호출이 밀리고 있습니다',
  RATE_LIMIT: 'KIS 초당 호출 한도를 넘겨 거절이 나고 있습니다 (배치·결제 동시 호출)',
};

/** 지연 지속 상태를 갱신하고, 6시간에 닿으면 알린다 (원인 불문 하나의 알람) */
async function applySlowPersist(
  prisma: PrismaClient,
  assetClass: AssetClass,
  slow: boolean,
  cause: QuoteDelayCause,
  now: Date,
): Promise<boolean> {
  const prev = await readSlowState(prisma, assetClass);
  const { next, fire } = decideSlowPersistAlert(prev, slow, now.getTime(), {
    alertAfterMs: SLOW_ALERT_AFTER_MS,
    gapResetMs: SLOW_GAP_RESET_MS,
  });
  await writeSlowState(prisma, assetClass, next);
  if (fire) {
    const hours = Math.round(SLOW_ALERT_AFTER_MS / 3_600_000);
    void notifyOperators(prisma, {
      title: `[P1] ${assetClass} 시세 호출이 ${hours}시간째 지연되고 있습니다`,
      body: [
        `${CAUSE_LABEL[cause]}.`,
        `일시적 급등이 아니라 호출량이 계정 한도(초당 1회)를 넘어선 신호입니다 — 시세 소스를 늘리거나(코인은 상한만 올리면 됨) 회차 상한·캐시를 조정하세요.`,
        `결제 차단은 별도 실시간 조회라 그동안에도 돈은 새지 않습니다.`,
      ].join('\n'),
      // **원인이 달라도 자산군당 하나의 알람** — 겹친 원인으로 두 통 가지 않게
      dedupeKey: `quote-delay:${assetClass}`,
      dedupeMs: SLOW_ALERT_AFTER_MS,
      link: '/admin',
    });
  }
  return fire;
}

/**
 * 감시 60-cap 밖의 경로(결제 폭주·KIS 초당 초과)가 지연을 보고한다 — **올리기만** 한다.
 * 띠지에 slow를 찍고 지속 시계를 이어 간다. 해제는 감시 회차가 정상을 확인할 때만.
 */
export async function reportQuoteDelay(
  prisma: PrismaClient,
  assetClass: AssetClass,
  cause: QuoteDelayCause,
  detail: string,
  now = new Date(),
): Promise<{ fired: boolean }> {
  await recordSourceHealth(prisma, assetClass, 'slow', detail, now);
  const fired = await applySlowPersist(prisma, assetClass, true, cause, now);
  return { fired };
}

async function readSlowState(
  prisma: PrismaClient,
  assetClass: AssetClass,
): Promise<SlowAlertState | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: SLOW_KEY(assetClass) } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as SlowAlertState;
  } catch {
    return null;
  }
}

async function writeSlowState(
  prisma: PrismaClient,
  assetClass: AssetClass,
  state: SlowAlertState | null,
): Promise<void> {
  if (state === null) {
    // 지연이 풀렸다 — 상태를 지운다(다음 지연은 처음부터 다시 센다)
    await prisma.appSetting.deleteMany({ where: { key: SLOW_KEY(assetClass) } });
    return;
  }
  const value = JSON.stringify(state);
  await prisma.appSetting.upsert({
    where: { key: SLOW_KEY(assetClass) },
    update: { value },
    create: { key: SLOW_KEY(assetClass), value },
  });
}

export interface QuoteRefreshHealth {
  /** 감시 대상 수 */
  watched: number;
  /** 이번 회차에 갱신한 수 */
  refreshed: number;
  /** 상한을 넘겨 못 갱신한 수 (>0 이면 지연) */
  skipped: number;
}

export async function noteQuoteRefreshHealth(
  prisma: PrismaClient,
  assetClass: AssetClass,
  r: QuoteRefreshHealth,
  now = new Date(),
): Promise<{ fired: boolean }> {
  const slow = r.skipped > 0;

  // ① 띠지 stamp — 감시 대상이 0이면 판단 근거가 없어 stamp 안 함(직전 상태 유지)
  const health: SourceHealth | null = slow ? 'slow' : r.refreshed > 0 ? 'ok' : null;
  if (health) {
    await recordSourceHealth(
      prisma,
      assetClass,
      health,
      slow
        ? `장중 감시 ${r.watched}종목이 상한 60 초과 — ${r.skipped}종목 이번 회차 미갱신`
        : `장중 감시 ${r.refreshed}종목 갱신`,
      now,
    );
  }

  // ② 지연 지속 알람 — 감시 회차는 ok/slow를 authoritatively 판단하므로 해제도 한다
  const fired = await applySlowPersist(prisma, assetClass, slow, 'WATCH_CAP', now);
  return { fired };
}
