import 'dotenv/config';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { isJustAfterClose, isMarketOpen, isTradingDay, marketToday } from '../src/domain/marketHours';
import { coverageEndsIn, holidayName } from '../src/domain/marketCalendar';
import { BatchLockBusy, withBatchLock, type BatchFence } from '../src/server/batchLock';
import { backupDatabase } from '../src/server/dbBackup';
import { createDefaultRegistry, createSecondaryRegistry } from '../src/infra/marketData/registry';
import { toRiskLevel, type RiskLevel } from '../src/domain/instrumentRisk';
import { fetchUsHalts, fetchUsListings, financialStatusRisk } from '../src/infra/marketData/nasdaqTrader';
import { setInstrumentRisk, syncAllInstruments } from '../src/server/instrumentService';
import { judgeAndSettleDueCards } from '../src/server/judgmentBatch';
import { runReachedJudgmentBatch } from '../src/server/reachedJudgmentBatch';
import { runSalesCloseBatch } from '../src/server/salesCloseService';
import { confirmDelayedBaseBatch } from '../src/server/delayedBaseService';
import { classifySourceHealth } from '../src/domain/sourceHealth';
import { recordSourceHealth } from '../src/server/sourceHealthService';
import { refreshWatchedQuotes } from '../src/server/quoteWatchService';
import { takeMarketSnapshot } from '../src/server/marketStats';
import { runComplianceOps } from '../src/server/complianceOpsService';
import {
  CANARY_INTERVAL_MS,
  CANARY_STALE_MS,
  alertIfCanaryStale,
  runCanaryProbe,
  runScreeningCanary,
} from '../src/server/screeningCanaryRunner';
import { createStudentClientFromEnv } from '../src/infra/compliance/studentClient';
import {
  STUDENT_ATTENDANCE_INTERVAL_MS,
  STUDENT_ATTENDANCE_OFFSET_MS,
  alertIfAttendanceStale,
  markAttendanceTimerScheduled,
  runStudentAttendance,
} from '../src/server/studentAttendance';
import { checkWhitelistCollisions } from '../src/server/whitelistCollision';
import { notifyOperators, purgeOldNotifications } from '../src/server/opsAlert';
import {
  flushHardCapSurgeAlert,
  flushImplausibleQuoteSurgeAlert,
  flushOpsAlerts,
} from '../src/server/opsAlertFeed';
import { flushPendingPush } from '../src/server/pushService';
import {
  anotherSchedulerMayBeRunning,
  BEAT_INTERVAL_MS,
  clearHeartbeat,
  writeHeartbeat,
} from '../src/server/schedulerHealth';
import { seasonOf } from '../src/server/scoreService';
import { purgeExpiredPaymentIntents } from '../src/server/paymentIntentService';
import { purgeExpiredChallenges } from '../src/server/passkeyService';
import { sweepStuckRefundAttempts } from '../src/server/settlementOpsService';
import { notifyIfOutflowPressure } from '../src/server/payoutVelocity';
import { sweepPendingCompensations } from '../src/server/compensationService';
import { notifyApprovalReminders } from '../src/server/operatorApprovalService';
import { recalcSeasonTiers } from '../src/server/seasonRecalcService';
import { syncKrCardInstrumentRisk } from '../src/server/krRiskSync';
import { pausedAssetClasses } from '../src/server/judgmentPause';
import { healMissingCardData } from '../src/server/cardDataHealer';
import {
  probeAndMaybeResume,
  recentHaltEpisodes,
  sourceInstabilityVerdict,
  PROBE_MAX_FAILURES,
  SOURCE_INSTABILITY,
} from '../src/server/crossCheckRecovery';
import {
  emptyRangeAlerts,
  EMPTY_RANGE_STREAK,
  JUDGMENT_HARD_CAP_DAYS,
  STALE_DEFER_DAYS,
} from '../src/server/judgmentBatch';

// 배치 스케줄러 — npm run scheduler (상시 실행 프로세스)
//
// 왜 프로세스 하나인가: **배치가 겹치면 KIS 토큰 발급(분당 1회)에서 서로를 죽인다.**
// 크론으로 여러 배치를 각각 걸면 같은 분에 두 개가 뜨고, 둘 다 토큰이 없으면 동시에
// 발급을 요청해 하나가 실패한다(파일 캐시는 이미 발급된 뒤에만 도움이 된다).
// 게다가 초당 호출 제한도 계정 합산이라 두 프로세스의 큐가 서로를 모르고 겹쳐 나간다.
// 한 프로세스 안에서 **순차 큐**로 돌리면 두 문제가 함께 사라진다.
//
// 무엇을 언제 (모두 시장 시간 기준):
//   · 마감 +5분  국내 15:35 KST / 미국 16:05 ET → 그 시장만 판정·판매마감
//   · 장중 2분   열려 있는 시장의 감시 종목만 시세 갱신 (코인은 24시간, 한 번에)
//   · 매일 06:00 KST 종목 마스터 동기화 (정적 파일 — 위험 등급·ETF 제외 포함)
//   · 매시간     마켓 규모 스냅샷 (띠지 증감용)
// 판정은 멱등이라 창구 안에서 여러 번 돌아도 결과가 같다 — 잠깐 죽었다 살아나도
// 그날 판정을 놓치지 않게 창구를 넉넉히 잡았다.

const prisma = new PrismaClient();
const registry = createDefaultRegistry();
// 판정 교차검증용 두 번째 소스 (domain/crossCheck). 지금은 코인만 채워져 있고,
// 기본 모드가 `shadow`라 결론이 갈려도 기록만 남는다 — 검증되지 않은 소스에
// 정산을 멈출 권한을 주지 않는다. CROSS_CHECK_MODE=enforce로 올린다
const secondaryRegistry = createSecondaryRegistry();

const TICK_MS = 60_000;
const QUOTE_INTERVAL_MS = 2 * 60_000;
const RISK_RANK: RiskLevel[] = ['NONE', 'CAUTION', 'WARNING', 'DANGER'];
const MARKETS: Exclude<AssetClass, 'CRYPTO'>[] = ['KR_EQUITY', 'US_EQUITY'];

/**
 * 하루 한 번짜리 일이 오늘 돌았나 — **DB가 기억한다.**
 *
 * 예전에는 메모리 Map이었고, 거기에 시간 창구(예: 07:00~08:00)를 곱해 판단했다.
 * 두 장치가 함께 만들던 구멍: **배포가 그 창구에 걸리면 그날 그 일이 통째로 빈다.**
 * 재기동하면 메모리 기록이 사라져 다시 돌 자격은 생기는데, 창구를 이미 지나 버려
 * 조건이 안 맞는다. 컴플라이언스 보류 큐가 하루 안 도는 것은 리서처가 하루를 더
 * 기다린다는 뜻이고, 분기 시즌 재산정이 빠지면 등급이 한 분기 고정된다.
 *
 * → 기록은 DB에 남기고 **창구의 위쪽 끝을 없앤다.** 아래쪽 끝(그 시각 전에는 돌지
 * 않는다)은 뜻이 있다 — 백업은 시장이 닫힌 04:00에, 보류 큐는 하루 시작 전에 돌아야
 * 한다. 위쪽 끝은 "늦으면 하지 마라"인데 그럴 이유가 없다. **늦게라도 하는 게 낫다.**
 *
 * 24시간 간격(`now - lastRunAt > 24h`)으로 하지 않은 이유: 그건 하루 한 번이 아니라
 * **표류**다. 07:00에 돌고 다음 날 08:00에 재기동하면 08:00, 그다음은 09:00 …
 * 며칠이면 백업이 장중에 뜬다. 그래서 시각이 아니라 **날짜 키**를 적는다.
 */
const JOB_KEY_PREFIX = 'scheduler.lastRun.';
/** DB가 정본, 이건 캐시 — 매 틱 10번 조회하지 않으려고 둔다 */
const doneOn = new Map<string, string>();

async function loadJobHistory(): Promise<void> {
  const rows = await prisma.appSetting.findMany({
    where: { key: { startsWith: JOB_KEY_PREFIX } },
    select: { key: true, value: true },
  });
  for (const r of rows) doneOn.set(r.key.slice(JOB_KEY_PREFIX.length), r.value);
}

/**
 * 오늘(그 시장 날짜) 아직 안 돌았으면 true — **자리를 선점하고 표시는 성공 후에** 한다.
 * 메모리에 즉시 찍는 것은 같은 프로세스에서 두 번 큐에 들어가는 것을 막기 위함이고,
 * DB에 성공 후 찍는 것은 **하다가 죽은 일을 다음 기동이 다시 하게** 하기 위함이다.
 */
function claimDay(key: string, day: string): boolean {
  if (doneOn.get(key) === day) return false;
  doneOn.set(key, day);
  return true;
}

async function recordDay(key: string, day: string): Promise<void> {
  const dbKey = JOB_KEY_PREFIX + key;
  await prisma.appSetting.upsert({
    where: { key: dbKey },
    create: { key: dbKey, value: day, updatedBy: 'scheduler' },
    update: { value: day, updatedBy: 'scheduler' },
  });
}

/** 하루(또는 분기) 한 번짜리 일 — 선점 → 실행 → 성공하면 DB에 표시 */
function enqueueDaily(key: string, day: string, label: string, fn: () => Promise<void>): void {
  if (!claimDay(key, day)) return;
  enqueue(label, async () => {
    await fn();
    await recordDay(key, day);
  });
}

let lastQuoteAt = 0;

/**
 * 종료 신호를 받았나 — **받았으면 남은 큐를 버린다.**
 *
 * 예전에는 종료 시 큐를 끝까지 비웠다. 그런데 이 큐에는 판정 40회차(최대 800장 ×
 * 1.1초 ≈ 15분)가 들어갈 수 있어서 **pm2의 kill_timeout 안에 절대 못 끝난다** —
 * 결국 SIGKILL로 잘리고, 그 뒤에 걸어 둔 `clearHeartbeat`이 실행되지 않는다.
 * 그러면 정상으로 멈춘 스케줄러를 헬스 엔드포인트가 **문턱만큼 "살아 있다"고 답한다.**
 *
 * 남은 일을 버려도 되는 근거: 판정은 카드마다 단일 트랜잭션이라 중간에 멈춰도 반쪽짜리
 * 레코드가 남지 않고, 멱등이라 다음 기동의 따라잡기가 그대로 이어받는다.
 * **끝까지 하는 것보다 정직하게 멈추는 것이 낫다.**
 */
let stopping = false;

/**
 * 지금 큐에서 도는 항목 — 심박이 이걸 함께 싣는다.
 *
 * "프로세스가 살아 있나"와 "일이 되고 있나"는 다른 질문이라 답도 따로 낸다
 * (schedulerHealth 머리말). 항목 이름과 시작 시각을 실어 두면, 막혔을 때
 * **무엇이** 막혔는지가 헬스 응답에 그대로 나온다
 */
let current: { label: string; since: Date } | null = null;

/** 긴 작업이 한 단위를 끝낼 때마다 부른다 — 시작 시각을 당겨 "막힘" 판정을 조인다 */
function markProgress(): void {
  if (current) current.since = new Date();
}

/** 모든 일이 이 큐를 지난다 — 동시에 두 배치가 KIS를 두드리지 않게 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue(label: string, fn: () => Promise<void>): void {
  queue = queue
    .then(async () => {
      if (stopping) return; // 종료 중 — 진행 중인 것만 끝내고 나머지는 다음 기동에 넘긴다
      const t0 = Date.now();
      current = { label, since: new Date() };
      try {
        await fn();
        console.log(`[${new Date().toISOString()}] ${label} 완료 (${Date.now() - t0}ms)`);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] ${label} 실패:`, (e as Error).message);
      } finally {
        current = null;
      }
    })
    .catch(() => undefined);
}

/** 한 회차가 아무리 밀려도 이만큼만 — 무한 루프 방지 (20장 × 40 = 800장) */
const MAX_JUDGE_CHUNKS = 40;

/**
 * 판정 한 시장 — **락을 쥐고 돈다.**
 *
 * 큐가 하나라 이 프로세스 안에서는 이미 직렬인데도 락을 거는 이유는 **밖**이다:
 * 사람이 `npm run batch:judge`를 손으로 돌리는 순간 두 벌이 겹치고, KIS 토큰이
 * 분당 1회라 한쪽이 통째로 죽는다. 락을 못 잡으면 기다리지 않고 이번 회차를
 * 건너뛴다 — 판정은 멱등이고 창구가 1시간이라 다음 틱이 어차피 잡는다.
 */
async function judgeMarket(assetClass: AssetClass): Promise<void> {
  try {
    await withBatchLock(prisma, 'judge', (lock) => judgeMarketLocked(assetClass, lock));
  } catch (e) {
    if (e instanceof BatchLockBusy) {
      console.warn(`⚠ ${e.message} — ${assetClass} 판정을 이번 회차는 건너뜁니다`);
      return;
    }
    throw e;
  }
}

/**
 * **정지가 스스로 풀릴 수 있는지 본다** — 판정 일정과 **분리된** 자기 주기로 돈다
 * (server/crossCheckRecovery).
 *
 * 처음에는 이걸 판정 경로 안에 뒀는데 **시간 눈금이 두 자릿수 어긋나 있었다**:
 * 판정은 `enqueueDaily`라 자산군당 하루 한 번인데, 자동 회복이 흡수해야 하는 장애는
 * 10~30분짜리다. 그러면 순간 단절로 멈춘 자산군이 **꼬박 하루를 서 있고**, 6회
 * 실패에 닿는 데 6일이 걸린다 — 그동안 카드는 14일 상한을 향해 간다.
 *
 * 그래서 **틱(1분)마다 자격을 보고, 백오프가 실제 주기를 정한다**
 * (PROBE_BACKOFF_MIN: 0·2·4·8·16·32분).
 */
async function probePausedMarkets(): Promise<void> {
  const paused = await pausedAssetClasses(prisma);
  for (const assetClass of paused) {
    // 사람이 건 정지에는 아무 일도 하지 않는다 — 자격 검사가 그 안에 있다
    const probe = await probeAndMaybeResume(
      prisma,
      registry,
      assetClass,
      secondaryRegistry,
      new Date(),
    );
    if (probe.resumed) {
      console.log(`  ${assetClass}: 탐침 ${probe.checked}장 전원 합의 — 자동 판정 재개`);
      await alertOps(
        `[확인] ${assetClass} 자동 판정 재개 — 두 소스가 다시 일치합니다`,
        `정지 중 탐침 ${probe.checked}장이 모두 같은 결론을 냈습니다 (일시 장애로 판단).\n` +
          `판정을 재개했습니다. 원인이 궁금하면 감사 로그의 자동 해제 기록을 보세요.`,
        '/admin/judgments',
        `judge:resume:${assetClass}`,
      );

      // **잘 풀린다고 조용히 넘어가면 안 된다** — 자동 해제가 잦다는 것은 소스가
      // 계속 흔들리고 있다는 뜻이고, 그 사실은 자동 해제가 실패하는 날이 아니라
      // 지금 알아야 계약을 다시 볼 수 있다 (crossCheckRecovery.SOURCE_INSTABILITY)
      const verdict = sourceInstabilityVerdict(await recentHaltEpisodes(prisma));
      if (verdict.overFrequency || verdict.overDuration) {
        await alertOps(
          `[확인] 시세 소스가 반복해서 흔들립니다 — 교체를 검토하세요`,
          `최근 ${SOURCE_INSTABILITY.WINDOW_DAYS}일: 자동 정지 ${verdict.counted}회 · ` +
            `누적 ${Math.round(verdict.totalMinutes)}분 (${SOURCE_INSTABILITY.JITTER_MINUTES}분 미만은 빈도에서 제외).\n` +
            (verdict.overFrequency
              ? `· 빈도 초과 — 엔드포인트 설정이나 2차 피드 도입을 보세요.\n`
              : '') +
            (verdict.overDuration
              ? `· 누적 시간 초과 — 공급자의 복구 능력 문제입니다. 계약을 보세요.\n`
              : '') +
            `자동 해제가 잘 돌아서 아무도 아프지 않았지만, 그동안 판정은 그만큼 밀렸습니다.`,
          '/admin/judgments',
          `judge:unstable:${assetClass}`,
        );
      }
    } else if (probe.hardLocked) {
      // **자동 해제를 포기했다** — "곧 풀리겠지"라는 기대가 개입을 늦추면 안 된다
      // **원인이 둘이고 처방이 다르다** — 어느 쪽인지 말해 주지 않으면 운영자가
      // 시세를 대조하러 가는데 정작 볼 곳은 공급자 상태 페이지일 수 있다
      const outage = probe.providerDown > 0;
      await alertOps(
        `[P0] ${assetClass} 자동 재개 포기 — 사람이 풀어야 합니다`,
        `탐침이 ${probe.failures}회 연속으로 실패했습니다. 일시 장애가 아닙니다.\n` +
          (outage
            ? `마지막 회차의 원인은 **공급자 응답 없음**입니다 (${probe.providerDown}건).\n` +
              `시세를 대조할 것이 아니라 공급자 상태를 확인하세요.\n`
            : `마지막 회차의 원인은 **두 소스의 결론 불일치**입니다.\n` +
              `두 소스를 직접 대조하세요 (npm run probe:sources).\n`) +
          `이 상태로 두면 그 자산군의 카드가 차례로 14일 상한(전액 환불)에 닿습니다.\n` +
          `상한은 지금부터 24시간 더 미뤄집니다 — 그 안에 손대지 않으면 자동으로 전액 환불로 닫힙니다.`,
        '/admin/judgments',
        `judge:hardlock:${assetClass}`,
      );
    }
  }
}

async function judgeMarketLocked(assetClass: AssetClass, lock: BatchFence): Promise<void> {

  // **기준가를 먼저 확정한다** (DAY_CLOSE_AT_CLOSE — 장중·장후 게시 <14일 주식).
  // 게시일 마감 종가로 기준가를 확정해야 그 카드가 판매·판정 대상이 된다. 판정 배치보다
  // 먼저 돌아, 방금 확정된 카드가 이후 종가로 이미 목표에 닿았으면 같은 회차의 도달 판정이
  // 이어서 처리한다. 코인은 이 모드를 쓰지 않아 대상이 없다(장 마감이 없다).
  const base = await confirmDelayedBaseBatch(prisma, registry, new Date(), assetClass);

  // **자격 검사를 쓰기마다 들려 보낸다** — 락을 뺏긴 뒤 깨어난 프로세스가 남은 카드를
  // 계속 쓰는 것을 막는 유일한 장치다 (batchLock 상단 "펜싱 토큰" 주석)
  const reached = await runReachedJudgmentBatch(prisma, registry, new Date(), assetClass, lock.fence);

  // **밀린 카드를 다 소진할 때까지 커서로 이어서 돈다.** 판정은 한 회차 20장으로 끊기는데
  // (JUDGE_BATCH_SIZE — KIS 호출 간격 1.1초 때문에 한 번에 다 하면 큐가 통째로 막힌다),
  // 분기말처럼 시한이 몰린 날 20장만 하고 내일로 넘기면 정산이 하루씩 밀린다.
  //
  // **커서가 없으면 이월 카드가 앞자리를 영구히 막는다** — 이월은 Judgment를 안 만들어
  // 다음 조회에도 그대로 잡히기 때문이다. 그러면 뒤의 멀쩡한 카드가 영영 판정되지 않는다
  const due = await judgeAndSettleDueCards(
    prisma,
    registry,
    new Date(),
    assetClass,
    undefined,
    lock.fence,
    secondaryRegistry,
  );
  let chunks = 1;
  while (due.hasMore && due.cursor && chunks < MAX_JUDGE_CHUNKS && !stopping) {
    const next = await judgeAndSettleDueCards(
      prisma,
      registry,
      new Date(),
      assetClass,
      due.cursor,
      lock.fence,
      secondaryRegistry,
    );
    due.judged += next.judged;
    due.deferred += next.deferred;
    due.failed += next.failed;
    due.staleDeferred.push(...next.staleDeferred);
    due.implausible.push(...next.implausible);
    due.hardCapped.push(...next.hardCapped);
    due.blockedInstruments.push(...next.blockedInstruments);
    due.failures.push(...next.failures);
    due.disagreed.push(...next.disagreed);
    for (const c of next.haltedAssetClasses) {
      if (!due.haltedAssetClasses.includes(c)) due.haltedAssetClasses.push(c);
    }
    // 빈 배열 집계는 **회차를 합쳐야 비율이 의미를 갖는다** — 20장씩 끊어 보면
    // 분모가 작아 우연히 100%가 나오는 회차가 생긴다
    for (const [src, stat] of next.emptyRange) {
      const acc = due.emptyRange.get(src);
      if (!acc) {
        due.emptyRange.set(src, stat);
        continue;
      }
      acc.attempted += stat.attempted;
      acc.empty += stat.empty;
      for (const t of stat.stuckTickers) {
        if (!acc.stuckTickers.includes(t)) acc.stuckTickers.push(t);
      }
    }
    due.cursor = next.cursor ?? due.cursor;
    due.hasMore = next.hasMore;
    chunks += 1;
    // **회차 하나가 곧 한 단위의 진척이다.** 이걸 알리지 않으면 밀린 판정을 소진하는
    // 동안(최대 15분) 하나의 긴 항목으로 보여 "막힘" 문턱을 그만큼 헐겁게 잡아야 한다.
    // 회차마다 시작 시각을 당기면 문턱이 20장(≈22초) 단위로 조여진다
    markProgress();
  }
  if (due.hasMore) {
    console.warn(`  ${assetClass}: 판정 대기가 ${MAX_JUDGE_CHUNKS}회차 상한에 걸렸습니다 — 다음 창구로 이월`);
  }

  const sales = await runSalesCloseBatch(prisma, new Date(), registry, assetClass);
  console.log(
    `  ${assetClass}: 기준가확정 ${base.confirmed}(무효 ${base.invalidated}, 대기 ${base.notYet}) / 도달 ${reached.judged} / 기한 ${due.judged}(이월 ${due.deferred}, ${chunks}회차) / 판매마감 ${sales.closed.length}`,
  );

  // **시세 소스 헬스 도장** (2026-08-29) — 이미 돈 이 회차의 결과를 세 상태(정상/지연/장애)로
  // 접어 남긴다. 관리자 홈 띠지가 읽어 "소스 죽음 vs 그냥 붐빔"을 판정 정지와 함께 보여준다.
  // 새로 시세를 부르지 않는다 — 이미 나온 providerDown·emptyRange·hasMore를 접을 뿐.
  const providerDownCount = [...due.providerDown.values()].reduce((a, b) => a + b, 0);
  const emptyBulk = emptyRangeAlerts(due.emptyRange).some((a) => a.bulk);
  const health = classifySourceHealth({
    providerDownCount,
    emptyRangeBulk: emptyBulk,
    hasMore: due.hasMore,
    touched: due.judged + due.deferred + due.failed > 0,
  });
  if (health) {
    const detail =
      health === 'down'
        ? providerDownCount > 0
          ? `공급자 응답 없음 ${providerDownCount}건`
          : '빈 시세 대량'
        : health === 'slow'
          ? '회차 상한 — 다음 창구로 이월'
          : `판정 ${due.judged}건 정상`;
    await recordSourceHealth(prisma, assetClass, health, detail);
  }

  // **이월이 오래된 카드는 사람이 봐야 한다.** 지금까지 이 목록은 배치 로그에만 남아
  // 아무도 읽지 않았다 — 돈이 묶인 카드가 조용히 방치되는 경로다
  // **시스템이 끝낸 건은 사람이 반드시 알아야 한다** — 전액 환불이 이미 나갔고,
  // 리서처에게는 자기 잘못이 아닌 판정 불가가 기록됐다. 조용히 지나가면 안 되는 사건이다
  if (due.hardCapped.length > 0) {
    await alertOps(
      `[확인] 판정 상한 도달 ${due.hardCapped.length}건 — 판정 불가·전액 환불 처리됨`,
      `시한 후 ${JUDGMENT_HARD_CAP_DAYS}일이 지나도록 시세를 구하지 못해 시스템이 닫았습니다.\n` +
        `시세 소스 문제인지 확인하고, 반복되면 소스를 바꿔야 합니다.\n` +
        due.hardCapped.slice(0, 10).join('\n'),
      '/admin/judgments',
      `judge:hardcap:${assetClass}`,
    );
  }

  // **유니버스가 줄어든 사건이다.** 리서처는 다음 게시에서야 알게 되므로, 원인이
  // 시세 소스 쪽이면 사람이 먼저 풀어야 한다 (`npm run risk:set`으로 되돌린다)
  if (due.blockedInstruments.length > 0) {
    await alertOps(
      `[확인] 판정 불가 반복 종목 ${due.blockedInstruments.length}건 — 신규 게시 중단`,
      `같은 종목에서 판정 불가가 반복돼 신규 카드 게시를 막았습니다.\n` +
        `진행 중인 카드와 돈은 그대로입니다. 시세 소스 문제라면 고친 뒤 등급을 되돌리세요.\n` +
        due.blockedInstruments.join('\n'),
      '/admin/judgments',
      `judge:blocked:${assetClass}`,
    );
  }

  // **시세 공급자가 응답하지 못했다** (2026-08-15).
  //
  // 전에는 이것이 아래 "[버그]"에 함께 담겨 나갔다. 그런데 이 통에 더 흔하게 들어오는 것이
  // 공급자 장애이고, 그건 **기다리면 낫고 우리 코드를 봐도 나올 것이 없다** —
  // 알림이 운영자를 로그로 보내 코드를 뒤지게 만들었는데 정작 볼 곳은 공급자 상태였다.
  //
  // 종목이 아니라 **소스별 건수**를 싣는다: 소스가 죽으면 그 소스를 쓰는 카드가 전부
  // 걸리므로 종목 목록은 길기만 하고 아무것도 말해 주지 않는다. "kis 43건"이면 충분하다.
  if (due.providerDown.size > 0) {
    const lines = [...due.providerDown].map(([src, n]) => `  ${src}: ${n}건`);
    await alertOps(
      `[P0] 시세 공급자 응답 없음 — ${assetClass} 판정이 멈췄습니다`,
      `시세를 **물어보지도 못한** 카드입니다 (인증 만료·HTTP 오류·응답 실패).\n` +
        `우리 코드 문제가 아니므로 로그를 뒤질 필요가 없습니다 — 공급자 상태를 확인하세요.\n` +
        `소스가 살아나면 다음 회차가 스스로 잡습니다. 다만 시한 후 ${JUDGMENT_HARD_CAP_DAYS}일이 되면 ` +
        `시스템이 전액 환불로 닫으므로, 길어지면 수동 판정을 검토해야 합니다.\n` +
        lines.join('\n'),
      '/admin/judgments',
      `judge:provider:${assetClass}`,
    );
  }

  // **두 시세 소스가 다른 답을 냈다** (2026-08-15, domain/crossCheck).
  //
  // 다른 알림과 성격이 다르다: 나머지는 "판정을 못 했다"인데 이건 **"판정을 했는데
  // 어느 쪽이 맞는지 모른다"**다. 그리고 이 상태가 뜻하는 것은 둘 중 하나이고 둘 다
  // 나쁘다 — 한 소스가 틀렸거나(그 소스로 나간 **과거 판정들도 의심스럽다**),
  // 값이 목표선을 사이에 두고 갈릴 만큼 아슬아슬한 카드거나.
  //
  // 카드는 이미 수동 판정 큐에 올라가 있고 즉시 판정할 수 있다. 방치하면 시한 후
  // 14일에 시스템이 전액 환불로 닫는다 — 리서처가 맞혔더라도 0점이 된다.
  // **자동 판정이 스스로 섰다** — 불일치가 무더기라 한 소스가 깨졌다고 본 것이다
  // (judgmentBatch.shouldHaltOnDisagreement). 다른 알림과 달리 **이미 판정이 멈춰 있다.**
  for (const halted of due.haltedAssetClasses) {
    await alertOps(
      `[P0] ${halted} 자동 판정 정지 — 시세 소스가 깨진 것으로 보입니다`,
      `한 회차에서 불일치가 무더기로 나 자동 판정을 세웠습니다 (전체 ${due.disagreed.length}건).\n` +
        `합의한 카드도 안전한 것이 아닙니다 — 목표선을 사이에 두지 않았을 뿐입니다.\n` +
        `두 소스의 일봉을 직접 확인하세요 (npm run probe:sources).\n` +
        `소스가 스스로 돌아오면 탐침이 확인 후 자동으로 재개합니다 — ` +
        `${PROBE_MAX_FAILURES}회 확인해도 계속 갈리면 사람만 풀 수 있는 상태가 됩니다.\n` +
        `정지 중에도 시한 후 ${JUDGMENT_HARD_CAP_DAYS}일 상한(전액 환불)은 계속 집행됩니다.`,
      '/admin/judgments',
      `judge:halt:${halted}`,
    );
  }

  if (due.disagreed.length > 0) {
    await alertOps(
      `[P0] 시세 소스 간 판정 불일치 ${due.disagreed.length}건 — 사람이 판정해야 합니다`,
      `두 시세 소스가 같은 카드에 다른 결론을 냈습니다. 자동 판정을 멈추고 수동 큐에 올렸습니다.\n` +
        `두 소스의 일봉을 나란히 놓고 어느 쪽이 맞는지 확인한 뒤 판정하세요.\n` +
        `한쪽 소스가 틀린 것으로 드러나면 **그 소스로 나간 최근 판정들도 함께 봐야 합니다.**\n` +
        `${JUDGMENT_HARD_CAP_DAYS}일 안에 손대지 않으면 전액 환불로 닫힙니다.\n` +
        due.disagreed.slice(0, 10).join('\n'),
      '/admin/judgments',
      `judge:disagree:${assetClass}`,
    );
  }

  // **200 OK + 빈 배열 — 예외가 없어 아무 감시에도 안 걸리던 실패** (2026-08-15).
  //
  // 지금까지 이건 평범한 "이월"로 흘러가 며칠 뒤 정차 알림(7일)이 잡았다. 그 7일 동안
  // 신규 판정과 정산이 통째로 서고 에스크로가 묶인다 — 돈이 묶인 고객에게 일주일은
  // 서비스를 떠나기에 충분한 시간이라, 인프라 장애(5xx)와 같은 등급으로 올린다.
  for (const { sourceId, stat, bulk } of emptyRangeAlerts(due.emptyRange)) {
    const pct = stat.attempted > 0 ? Math.round((stat.empty / stat.attempted) * 100) : 0;
    await alertOps(
      bulk
        ? `[P1] ${sourceId}: 판정 대상의 ${pct}%가 빈 시세 (${stat.empty}/${stat.attempted}건)`
        : `[확인] ${sourceId}: 같은 종목의 시세가 계속 비어 있습니다 (${stat.stuckTickers.length}종목)`,
      (bulk
        ? `공급자가 오류 없이 **빈 배열**을 주고 있습니다 — 장애가 아니라 스펙 변경이나 ` +
          `부분 중단일 수 있습니다. 그동안 판정과 정산이 서고 에스크로가 묶입니다.\n` +
          `소스의 응답을 직접 확인하세요 (npm run smoke:market).\n`
        : `소스 전체는 정상인데 특정 종목만 계속 비어 있습니다 — 티커 변경·거래 중단·` +
          `상장폐지 직전일 수 있습니다. 비율 알림에는 걸리지 않는 갈래입니다.\n`) +
        (stat.stuckTickers.length > 0
          ? `${EMPTY_RANGE_STREAK}회 이상 반복: ${stat.stuckTickers.slice(0, 20).join(', ')}`
          : ''),
      '/admin/judgments',
      `judge:empty:${sourceId}:${bulk ? 'bulk' : 'stuck'}`,
    );
  }

  // **예상 밖 오류에는 다른 발견 경로가 없다.** 이월은 정차 큐가, 상한은 전용 알림이
  // 받아 주지만 이건 콘솔에만 남았었다 — 그러는 동안 그 카드의 돈은 에스크로에 잠겨 있다.
  // 공급자 장애를 위에서 걷어냈으므로 **여기 남는 것은 정말로 우리 코드 문제**다.
  if (due.failures.length > 0) {
    await alertOps(
      `[버그] 판정 오류 ${due.failures.length}건 — 코드 확인 필요`,
      `시세 미도달도 공급자 장애도 아닌 **예상 밖 오류**입니다.\n` +
        `기다린다고 낫지 않으니 로그를 보고 고쳐야 합니다. 고칠 때까지 에스크로가 잠깁니다.\n` +
        due.failures.slice(0, 10).join('\n'),
      '/admin/judgments',
      `judge:bug:${assetClass}`,
    );
  }

  // ── 이상 시세가 **몰린 날** (2026-08-16) ────────────────────────────
  // 건별로는 그 종목의 사고라 조용히 큐로 보내지만, 전쟁·급락처럼 시장 전체가
  // 흔들리는 날에는 여러 개가 한꺼번에 몰린다. 그때 운영자가 할 일은 건건이
  // 판정하는 것이 아니라 **오늘이 어떤 날인지 아는 것**이다
  if (due.implausible.length > 0) {
    console.warn(`  이상 시세로 수동 큐 이동: ${due.implausible.length}건`);
    await flushImplausibleQuoteSurgeAlert(prisma, due.implausible.length);
  }

  if (due.staleDeferred.length > 0) {
    await alertOps(
      `판정 이월 ${due.staleDeferred.length}건 — 수동 확인 필요`,
      `${STALE_DEFER_DAYS}일 넘게 판정되지 못한 카드입니다. 운영자 판정 큐에서 처리하세요.\n` +
        due.staleDeferred.slice(0, 10).join('\n'),
      '/admin/judgments',
      `judge:stale:${assetClass}`,
    );
  }
}

/**
 * 배치가 사람을 부른다 — **인앱과 웹훅 양쪽으로** (2026-08-15).
 *
 * 여기 로컬 구현이 따로 있었고 그것은 `prisma.notification`만 썼다. 즉 판정 배치의
 * 알림 — 이월 정차·상한 도달·공급자 장애·종목 차단 — 이 전부 **인앱 전용**이라
 * 운영자가 어드민 앱을 열어야만 보였다. 고위험 감사 알림은 웹훅을 타는데
 * **정작 돈이 묶이는 배치 사고가 안 타고 있었다.**
 *
 * 공용 `notifyOperators`(server/opsAlert)로 옮기면 웹훅이 따라오고 중복 억제도 딸려온다.
 * `dedupeKey`를 자산군별로 주는 이유: 같은 사고가 매일 도는 배치마다 다시 알려지면
 * 그 채널을 안 보게 된다 — 하루 한 번이면 "아직 안 풀렸다"를 전하기에 충분하다.
 */
async function alertOps(
  title: string,
  body: string,
  link: string,
  dedupeKey: string,
): Promise<void> {
  await notifyOperators(prisma, {
    title,
    body,
    link,
    type: 'OPS_ALERT',
    dedupeKey,
    dedupeMs: 24 * 3_600_000,
  });
}

function tick(): void {
  const now = new Date();

  // **고위험 행위를 사람에게 보낸다** — 감사 로그에서 파생시키므로 웹이든 CLI든
  // 빠질 자리가 없다 (server/opsAlertFeed). 매 틱 도는 이유는 세션이 털렸을 때
  // 아는 시점이 빠를수록 피해가 작기 때문이다
  enqueue('고위험 작업 알림', async () => {
    const { sent } = await flushOpsAlerts(prisma, new Date());
    if (sent > 0) console.log(`고위험 작업 알림 ${sent}건 발송`);
  });

  // **시스템이 스스로 닫은 환불은 위 경로에 안 잡힌다** — 사람이 실행한 것이 아니라
  // 감사 기록이 없기 때문. 회차당 조금씩 나가 총량이 한도 안이면 아무도 모르는
  // 채로 대량 환불이 진행된다 (server/opsAlertFeed.flushHardCapSurgeAlert)
  enqueue('상한 환불 급증 확인', async () => {
    const { alerted, count } = await flushHardCapSurgeAlert(prisma, new Date());
    if (alerted) console.warn(`상한 환불 급증 알림 발송 — 오늘 ${count}건`);
  });

  // **인앱 알림을 이용자 폰으로 내보낸다** (server/pushService).
  // 알림 행은 판정·정산 트랜잭션 안에서 태어나고 그 안에서는 I/O가 금지라
  // (noIoInTransaction) 그 자리에서 못 보낸다. 대신 아직 안 보낸 행을 여기서 훑는다 —
  // **새 알림 종류가 생겨도 자동으로 따라오므로 다음 사람이 빠뜨릴 수가 없다.**
  // 매 틱 도는 이유는 계좌 변경·낯선 기기 로그인처럼 **분이 아까운 알림**이 섞여 있어서다.
  // 공급자(FCM)가 설정 안 됐으면 아무 일도 안 하고 즉시 돌아온다
  enqueue('푸시 발송', async () => {
    const r = await flushPendingPush(prisma, new Date());
    if (r.attempted > 0 || r.pruned > 0) {
      console.log(
        `푸시 ${r.delivered}/${r.attempted}건 발송` +
          (r.pruned > 0 ? ` · 죽은 구독 ${r.pruned}건 정리` : '') +
          (r.tooOld > 0 ? ` · 오래돼 건너뜀 ${r.tooOld}건` : ''),
      );
    }
  });

  // ── 정지 자동 해제 탐침 (틱마다 자격만 본다) ─────────────
  // **판정 일정과 분리돼 있다.** 판정은 하루 한 번인데 자동 회복이 흡수해야 하는
  // 장애는 10~30분짜리라, 판정 경로에 붙여 두면 순간 단절 하나에 하루를 선다.
  // 실제 주기는 백오프가 정한다 (0·2·4·8·16·32분) — 여기서는 매 틱 물어보기만 한다.
  enqueue('정지 자동 해제 탐침', probePausedMarkets);

  // ── 마감 직후 판정 (시장별) ─────────────────────────────
  // 여기만 창구를 유지한다 — 마감 전에 판정하면 안 되고, 놓친 날은 기동 따라잡기가
  // 시장을 가리지 않고 훑어 메운다. 창구를 지나 버린 경우의 대비가 이미 있는 유일한 일이다
  for (const market of MARKETS) {
    if (!isJustAfterClose(market, now)) continue;
    enqueueDaily(`judge:${market}`, marketToday(market, now), `${market} 마감 판정`, () =>
      judgeMarket(market),
    );
  }

  // 코인은 마감이 없다 — 한국 시각 09:05에 하루 한 번 (국내 개장 전에 끝난다)
  const kstNow = marketToday('KR_EQUITY', now);
  const kstClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  if (kstClock >= '09:05') {
    enqueueDaily('judge:CRYPTO', kstNow, '코인 일일 판정', () => judgeMarket('CRYPTO'));
  }

  // ── 거래일 달력 만료 경고 (매주 1회) ────────────────────
  // 달력이 끝나면 그 뒤 공휴일은 조용히 거래일로 취급된다 — 배치가 헛돌 뿐이지만
  // 아무도 모른 채 넘어가므로, 만료 30일 전부터 주 1회 운영자에게 알린다
  const weekKey = Math.floor(Date.parse(`${kstNow}T00:00:00Z`) / (7 * 86_400_000));
  for (const market of MARKETS) {
    const left = coverageEndsIn(market, marketToday(market, now));
    if (left > 30) continue;
    // **키는 시장, 값은 주차다.** 예전에는 키에 주차를 넣고 값에 날짜를 넣었는데,
    // 그러면 같은 주의 이튿날에 값이 달라져 다시 돈다 — 주석은 "주 1회"인데 실제로는
    // 매일 울리고 있었다. 매일 오는 경고는 곧 안 읽는 경고가 된다
    enqueueDaily(`calendar:${market}`, String(weekKey), '거래일 달력 만료 경고', () =>
      alertOps(
        `거래일 달력 갱신 필요 — ${market}`,
        left < 0
          ? `${market} 휴장일 달력이 ${-left}일 전에 끝났습니다. 지금은 공휴일도 거래일로 취급해 배치가 헛돕니다. src/domain/marketCalendar.ts에 다음 연도 휴장일을 추가해주세요.`
          : `${market} 휴장일 달력이 ${left}일 뒤 끝납니다. src/domain/marketCalendar.ts에 다음 연도 휴장일을 추가해주세요.`,
        '/admin',
        `calendar:${market}`,
      ),
    );
  }

  // ── DB 백업 (매일 04:00 KST) ────────────────────────────
  // 어느 시장도 열려 있지 않고 아침 배치들보다 앞선 시각이다. 그날의 배치가 DB를
  // 망가뜨렸을 때 **망가지기 직전 상태**로 돌아갈 수 있어야 하므로 배치보다 먼저 뜬다
  if (kstClock >= '04:00') {
    enqueueDaily('backup', kstNow, 'DB 백업', async () => {
      const r = await backupDatabase();
      console.log(`  ${path.basename(r.file)} — ${(r.bytes / 1_048_576).toFixed(1)}MB / 리포트 ${r.reports}건`);
    });
  }

  // ── 종목 마스터 동기화 (정적 파일 — 호출 제한 무관) ─────
  if (kstClock >= '06:00') {
    enqueueDaily('sync:instruments', kstNow, '종목 마스터 동기화', async () => {
      const results = await syncAllInstruments(prisma, registry);
      for (const r of results) {
        console.log(`  ${r.assetClass}: ${r.upserted}종 (비활성 ${r.deactivated})`);
      }
      // **방금 들어온 이름이 규칙을 끄지 않는지 본다** (14차 R-4).
      // 종목 마스터는 표기 회피 탐지의 화이트리스트라, 금지어와 충돌하는 이름이
      // 상장되면 그 규칙이 그 종목에서 조용히 꺼진다. 빼지 않고 알리기만 한다 —
      // 빼면 그 종목을 분석하는 성실한 리서처가 전부 막힌다(λ=4)
      const collisions = await checkWhitelistCollisions(prisma);
      if (collisions.length > 0) {
        console.log(`  ⚠ 금지 규칙과 충돌하는 종목명 ${collisions.length}건`);
      }
      // **동기화 직후 카나리아 1회** (회신 15호 §3) — knownNames 가 갈리는 순간이다.
      // 원인 직후 5초와 우연히 5분 뒤는 사고 조사에서 다른 값이다
      const probe = await runCanaryProbe(prisma, '종목 마스터 동기화 직후');
      console.log(
        probe.failures.length === 0
          ? '  카나리아(동기화 직후) 정상'
          : `  ⚠ 카나리아(동기화 직후) ${probe.failures.length}건 실패`,
      );
    });
    // 미국 상태는 나스닥 공개 파일에서 온다 (KIS가 주지 않는다) — 같은 시간대에 이어서.
    // 인증·요율 제한이 없어 전 종목을 한 번에 훑는다
    enqueueDaily('sync:us-status', kstNow, '미국 종목 상태(나스닥)', async () => {
      const [listings, halts] = await Promise.all([fetchUsListings(), fetchUsHalts()]);
      const ours = new Map(
        (
          await prisma.instrument.findMany({
            where: { assetClass: 'US_EQUITY' },
            select: { ticker: true, riskLevel: true },
          })
        ).map((r) => [r.ticker, r.riskLevel]),
      );
      let raised = 0;
      for (const l of listings) {
        const currentRisk = ours.get(l.ticker);
        if (!currentRisk) continue;
        const signal = financialStatusRisk(l.financialStatus);
        if (!signal) continue;
        const next = toRiskLevel(signal);
        // 등급은 올리기만 한다 — 운영자가 올려 둔 경고를 배치가 지우면 안 된다
        if (RISK_RANK.indexOf(next) <= RISK_RANK.indexOf(currentRisk as RiskLevel)) continue;
        await setInstrumentRisk(prisma, 'US_EQUITY', l.ticker, next, signal.note ?? null, {
          delistingRisk: signal.delisting,
        });
        raised++;
      }
      let halted = 0;
      for (const h of halts.filter((x) => !x.resumptionDate)) {
        if (!ours.has(h.ticker)) continue;
        await setInstrumentRisk(prisma, 'US_EQUITY', h.ticker, 'DANGER', `거래정지 (${h.reasonCode})`);
        halted++;
      }
      console.log(`  미국: 등급 상향 ${raised} / 거래정지 ${halted}`);
    });
  }

  // ── 장중 감시 갱신 (열린 시장만) ────────────────────────
  if (now.getTime() - lastQuoteAt >= QUOTE_INTERVAL_MS) {
    lastQuoteAt = now.getTime();
    const open: AssetClass[] = ['CRYPTO', ...MARKETS.filter((m) => isMarketOpen(m, now))];
    for (const assetClass of open) {
      enqueue(`감시 갱신 ${assetClass}`, async () => {
        const r = await refreshWatchedQuotes(prisma, registry, new Date(), 60, assetClass);
        if (r.watched > 0) {
          console.log(`  ${assetClass}: 감시 ${r.watched} / 갱신 ${r.refreshed} / 해제 ${r.released}`);
        }
      });
    }
  }

  // ── 마켓 규모 스냅샷 (매시 정각) ────────────────────────
  // 하루 여러 번짜리는 DB에 남기지 않는다 — 한 번 걸러도 다음 시각이 한 시간 뒤다
  if (kstClock.endsWith(':00') && claimDay(`snapshot:${kstClock}`, kstNow)) {
    enqueue('마켓 스냅샷', async () => {
      await takeMarketSnapshot(prisma);
    });
  }

  // ── 보류 큐 운영 (매일 07:00 KST) ───────────────────────
  // 이 배치가 없으면 컴플라이언스 보류 큐는 운영자가 열어볼 때까지 아무 일도 일어나지
  // 않는 블랙홀이 된다 (시한 경과 건의 초안 복귀·운영자 알림이 여기서 난다)
  if (kstClock >= '07:00') {
    enqueueDaily('compliance', kstNow, '보류 큐 운영', async () => {
      const s = await runComplianceOps(prisma);
      console.log(`  시한 경과 초안 복귀 ${s.expired.length}건`);
      // (카나리아 박동 감시는 심박 타이머로 옮겼다 — 회신 15호. 문턱 15분에 하루 한 번은 28배 성기다)
    });
  }

  // ── 규칙 검수 카나리아는 여기 없다 (회신 15호 §1) ──────────
  // 큐 밖 자기 타이머(canaryTimer, 5분)가 돌린다. 정규식 6회·외부 호출 0 이라 큐에 설 이유가
  // 없고, 큐에 서면 판정(수 분) 뒤에 밀리며 ":00" 분 매칭을 놓치면 한 시간이 통째로 빈다.

  // ── 방치된 환불 시도 (30분마다) ─────────────────────────
  // PENDING은 "취소가 나갔는지 우리가 모른다"는 뜻인데, 그 행을 아무도 다시 보지 않으면
  // 구매자 환불이 조용히 멈춘 채 남는다. 정산 큐에는 보이지만 큐를 안 열면 그만이다.
  // 건마다 알리면 소음이라 배치가 묶어서 한 번에 올린다(이미 알린 건은 다시 안 센다)
  if (kstClock.endsWith(':00') || kstClock.endsWith(':30')) {
    if (claimDay(`refund-sweep:${kstClock}`, kstNow)) {
      enqueue('방치된 환불 시도 점검', async () => {
        const s = await sweepStuckRefundAttempts(prisma);
        if (s.reconciled > 0) console.log(`  이미 실행된 정산의 시도 ${s.reconciled}건 정리`);
        if (s.stuck > 0) console.log(`  끝나지 않은 환불 시도 ${s.stuck}건 — 운영자에게 알림`);
      });
      // 결제 의도 정리도 같은 주기에 얹는다 — 둘 다 가볍고 DB만 만진다.
      // 만료 의도를 남기면 orderId에 박힌 reportId가 "누가 무엇을 사려다 말았는지"의
      // 목록이 된다 — 구매 전 마스킹 규칙 밖에 있는 유일한 표였다
      enqueue('만료 결제 의도 정리', async () => {
        const purged = await purgeExpiredPaymentIntents(prisma);
        if (purged > 0) console.log(`  만료 결제 의도 ${purged}건 삭제`);
      });
      // 지나간 패스키 챌린지도 같이 쓸어 담는다. 남겨 둬도 위험하진 않지만
      // (한 번 쓰면 지워지고, 만료 검사도 따로 한다) 안 쓰인 것들이 표에 쌓인다
      enqueue('만료 로그인 챌린지 정리', async () => {
        const purged = await purgeExpiredChallenges(prisma);
        if (purged > 0) console.log(`  만료 로그인 챌린지 ${purged}건 삭제`);
      });
      // **한도에 닿기 전에 부른다** (2026-08-16). 한도는 벽이지 신호가 아니라,
      // 지금까지 운영자가 그것을 아는 유일한 순간이 **거부당했을 때**였다.
      // 그때는 이미 정상 지급이 막힌 뒤라 원인보다 "어떻게 올리나"부터 묻게 된다
      enqueue('일일 출금 압력 점검', async () => {
        if (await notifyIfOutflowPressure(prisma)) {
          console.warn('  오늘 나간 돈이 일일 한도의 80%를 넘었습니다 — 운영자에게 알림');
        }
      });
    }
  }

  // ── 확정 안 된 귀책 보상 (매일 09:30 KST) ───────────────
  // 보상은 **전부 사람 확정을 거친다**(자동 승인 경로 없음). 그 대가로 이 큐는
  // 방치되면 리서처 돈이 갇히는 자리가 되므로, 검수 보류 큐와 같은 규칙을 쓴다 —
  // 사람을 기다리는 큐는 스스로 소리를 내야 한다
  if (kstClock >= '09:30') {
    enqueueDaily('compensation-review', kstNow, '귀책 확정 대기 보상 점검', async () => {
      const s = await sweepPendingCompensations(prisma);
      if (s.pending > 0) {
        console.log(`  귀책 확정 대기 보상 ${s.pending}건 (${s.overdue}건 지연)`);
      }
    });
  }

  // ── 승인 대기 만료 임박 재알림 (매일 09:30 KST) ─────────
  // 승인 요청 알림은 올라갈 때 1회뿐이라, 놓치면 요청이 조용히 만료된다(72h) —
  // "사람을 기다리는 큐는 스스로 소리를 내야 한다"(보상 큐와 같은 규칙).
  // 48시간 경과 건을 한 번만 다시 알린다 — 매일 울리면 알림이 배경음이 된다
  if (kstClock >= '09:30') {
    enqueueDaily('approval-reminder', kstNow, '승인 대기 만료 임박 점검', async () => {
      const n = await notifyApprovalReminders(prisma);
      if (n > 0) console.log(`  만료 임박(24시간 남음) 승인 요청 ${n}건 — 운영자 재알림`);
    });
  }

  // ── 오래된 알림 정리 (매일 04:30 KST — 백업 직후) ────────
  // 읽은 것만, 운영 경보는 남긴다. 목적은 용량이 아니라 P0 경보가 묻히지 않게 하는 것
  if (kstClock >= '04:30') {
    enqueueDaily('noti-purge', kstNow, '오래된 알림 정리', async () => {
      const purged = await purgeOldNotifications(prisma);
      if (purged > 0) console.log(`  읽은 알림 ${purged}건 삭제`);
    });
  }

  // ── 국내 시장경보·거래정지 (매일 07:10 KST) ─────────────
  // 마스터 파일은 관리종목까지만 준다. 투자경고·거래정지·정리매매는 현재가 응답에만
  // 있어 종목당 1회가 필요하므로, **카드가 걸린 종목만** 본다 (server/syncKrRisk 규칙)
  // 휴장일은 건너뛴다 — 시장경보 지정은 거래일에만 바뀐다
  if (kstClock >= '07:10' && isTradingDay('KR_EQUITY', now)) {
    enqueueDaily('risk:kr', kstNow, '국내 종목 경보 갱신', async () => {
      const s = await syncKrCardInstrumentRisk(prisma, registry);
      console.log(`  대상 ${s.checked}종목 — 상향 ${s.raised} / 수동값 유지 ${s.keptManual}`);
    });
  }

  // ── 결측값 치유 (매일 07:20 KST) ────────────────────────
  // 게시 때 시세가 잠깐 흔들려 σ·앵커가 빈 카드를 메운다. 안 하면 그 카드는 판정까지
  // 안정성 "—"에 분할 감지도 안 된다
  if (kstClock >= '07:20') {
    enqueueDaily('heal', kstNow, '카드 결측값 치유', async () => {
      const s = await healMissingCardData(prisma, registry);
      if (s.sigmaFilled + s.anchorFilled > 0) {
        console.log(`  σ ${s.sigmaFilled} / 앵커 ${s.anchorFilled} 채움 (실패 ${s.failed})`);
      }
    });
  }

  // ── 분기 시즌 재산정 (분기 시작 후 한 번) ────────────────
  // 등급 승급·강등이 일어나는 유일한 자리다. 빠져 있으면 등급이 한 분기 고정된다.
  //
  // **날짜가 아니라 분기를 키로 쓴다.** 예전에는 "1일 00:10~01:10"이라 그 한 시간에
  // 프로세스가 꺼져 있으면 **그 분기의 승급이 통째로 사라졌다** — 세 달에 한 번뿐인
  // 일이라 놓치는 대가가 가장 큰데 창구는 가장 좁았다. 분기 키로 적어 두면 5일에
  // 떠도 그때 돈다(recalcSeasonTiers는 now에서 **직전** 시즌을 유도하므로 늦어도 맞다)
  const [mm, dd] = kstNow.split('-').slice(1);
  const quarterStartToday = ['01', '04', '07', '10'].includes(mm) && dd === '01';
  if (!quarterStartToday || kstClock >= '00:10') {
    enqueueDaily(
      'season',
      seasonOf(now), // '2026-Q3' — 이 분기에 이미 돌았나
      '분기 시즌 재산정',
      async () => {
        const s = await recalcSeasonTiers(prisma);
        console.log(
          `  ${s.season}: 평가 ${s.evaluated}명 — 승급 ${s.promoted} / 강등 ${s.demoted}`,
        );
      },
    );
  }

}

/**
 * 심박 — **큐를 지나지 않는다.**
 *
 * 예전에는 큐 맨 뒤에 세워 "앞선 일이 막히면 심박도 멈춘다"를 좀비 감지로 썼다.
 * 그 대가로 문턱을 가장 긴 작업에 맞춰야 했고(밀린 판정 소진 15분), 그래서 진짜
 * 죽음의 탐지가 15분이나 걸렸다. 지금은 질문을 나눠 답한다(schedulerHealth 머리말):
 * 이 타이머는 **이벤트 루프가 살아 있나**만 말하고, **일이 되고 있나**는 심박에
 * 함께 싣는 `current`(도는 항목 + 시작 시각)가 말한다
 */
/** 문턱을 글로 적을 때 쓰는 분 단위 — 상수에서 뽑는다. 손으로 적어 두면 문턱을
 *  내려도 로그만 옛 숫자를 외치고, 그걸 읽는 사람이 제일 먼저 속는다 */
const STALE_MIN = Math.round(CANARY_STALE_MS / 60_000);

/**
 * 이 프로세스가 켜진 시각.
 *
 * **정지 판단에는 "얼마나 오래 지켜봤는가"가 필요하다** (2026-08-25, 실제 헛문자 두 통 뒤).
 *
 * 두 정지 알림은 DB 에 남은 `lastOk`(마지막 성공 시각)를 읽는다. 그런데 그 값은
 * **프로세스가 죽어 있던 시간까지 포함해** 낡아 있다 — 스케줄러가 하루 쉬면 재기동
 * 직후의 `lastOk` 는 무조건 하루 전이다. 그 상태에서 곧바로 물으면 답은 언제나
 * "멎었다"이고, 그건 IRIS 나 카나리아에 대한 사실이 아니라 **아무도 안 물어본 시간**의
 * 기록이다.
 *
 * 부팅 순서가 그것을 더 확실하게 만들고 있었다:
 *
 *     beat();                          ← 즉시. 여기서 두 알림이 나간다
 *     ...
 *     void markAttendanceTimerScheduled(prisma);   ← 8줄 뒤, await 도 안 함
 *
 * `beat()` 가 카나리아의 첫 통과보다도, 출근 점검 예약 기록보다도 먼저 돌았다.
 * 어제 넣은 개별 장치들이 전부 그 뒤에 있어 한 번도 닿지 못했다.
 *
 * 그래서 **개별 장치가 아니라 한 자리에서** 막는다: 이 프로세스가 문턱만큼 돌기 전에는
 * 정지 판단을 하지 않는다. 진짜 정지는 그 뒤에도 그대로 잡힌다 — 늦어지는 것은
 * 재기동 직후 한 창구뿐이고, 그 창구에서 나가는 알림은 **정의상 전부 거짓**이었다.
 */
const BOOT_AT = Date.now();

function beat(): void {
  void writeHeartbeat(prisma, current);

  /* **재기동 직후에는 "멎었나"를 묻지 않는다** — 위 주석. 심박 기록(writeHeartbeat)은
     그대로 남기므로 "프로세스가 살아 있나"는 이 창구에서도 답할 수 있다.
     막는 것은 **판단**뿐이다. */
  if (Date.now() - BOOT_AT < CANARY_STALE_MS) return;

  // **카나리아 박동은 다른 타이머가 본다** (회신 15호 §2). 심박은 큐와 별개라 큐가 막혀도
  // 돌고, 카나리아 타이머가 죽어도 돈다 — 그래서 여기가 "카나리아가 멎었다"를 말할 자리다.
  // 둘 다 죽으면 스케줄러가 죽은 것이고 그건 기존 워치독 몫. 알림은 dedupeKey 로 한 번만
  void alertIfCanaryStale(prisma).then((stale) => {
    if (stale && !stopping) console.log(`  ⚠ 규칙 카나리아 박동이 ${STALE_MIN}분 넘게 멎어 있습니다`);
  });
  // IRIS 출근 점검의 박동도 같은 자리에서 본다 (회신 16호) — 점검이 "결근"이라고 말하는 것과
  // 점검이 아예 안 도는 것은 다른 고장이고, 후자는 점검 자신이 말할 수 없다
  void alertIfAttendanceStale(prisma, studentClient).then((stale) => {
    if (stale && !stopping) console.log(`  ⚠ IRIS 출근 점검 박동이 ${STALE_MIN}분 넘게 멎어 있습니다`);
  });
}

/**
 * IRIS 출근 점검 — 규칙 카나리아와 대칭인 **큐 밖 자기 타이머** (회신 16호). 학생이 꺼져
 * 있으면(STUDENT_SIDECAR_URL 없음) 클라이언트가 null 이라 아무 일도 안 한다.
 * 클라이언트는 프로세스에 하나다 — consumeAvailabilityChange() 의 전이 기억이 인스턴스에
 * 살아서, 매번 새로 만들면 "붙었다→끊겼다"를 한 번도 보지 못한다.
 */
const studentClient = createStudentClientFromEnv();
function attendanceTick(): void {
  if (stopping) return;
  void runStudentAttendance(prisma, studentClient)
    .then((r) => {
      if (!r) return;
      console.log(
        `  IRIS 출근 점검: ${r.ok ? '근무 중' : '결근'}` +
          (r.notified === 'sent' ? ' (전이 — 알림 나감)' : ''),
      );
    })
    .catch((e) => console.error('IRIS 출근 점검 실패:', e));
}

/**
 * 규칙 검수 카나리아 — **큐 밖 자기 타이머** (회신 15호 §1). 정답이 정해진 6문장을 운영과
 * 같은 함수에 통과시켜 검수가 실제로 도는지 잰다(14차 R-1). enqueue 를 거치지 않으므로
 * 앞 작업에 밀리지 않고, 벽시계 분 매칭도 없다. 같은 프로세스다 — 프로세스를 나누면 심박도
 * 감시도 하나씩 더 생기고, 밀리초짜리 작업에 그럴 값이 없다.
 */
function canaryTick(): void {
  if (stopping) return;
  void runScreeningCanary(prisma)
    .then((r) => {
      console.log(
        r.failures.length === 0
          ? `  카나리아 ${r.ran}건 정상`
          : `  ⚠ 카나리아 ${r.failures.length}/${r.ran}건 실패: ${r.failures.map((f) => f.layer).join(', ')}`,
      );
    })
    .catch((e) => console.error('카나리아 타이머 실패:', e));
}

/**
 * 기동 직후 한 번 따라잡기.
 *
 * 판정은 "마감 +5분부터 한 시간" 창구에서만 돈다. 그 시간에 스케줄러가 꺼져 있었으면
 * 그날 판정이 통째로 비고, 다음 창구까지 하루가 밀린다. 그래서 시작할 때 **시장을
 * 가리지 않고 한 번** 돌려 밀린 것을 정리한다 (판정은 멱등이라 중복 실행이 안전하다).
 *
 * **시장마다 따로 큐에 넣는다.** 셋을 한 항목으로 묶으면 최악의 경우 45분짜리 항목이
 * 생겨(시장당 최대 800장 × 1.1초) "막힘" 문턱을 그만큼 헐겁게 잡아야 하고, 막혔을 때
 * 헬스 응답이 "기동 따라잡기"라는 뭉뚱그린 이름만 말한다. 쪼개면 어느 시장인지 나온다.
 * 종료할 때 남은 시장을 버리는 것도 큐가 알아서 한다(항목별 stopping 검사).
 */
function catchUpOnBoot(): void {
  for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
    enqueue(`기동 따라잡기 ${assetClass}`, () => judgeMarket(assetClass));
  }
  // **배포 직후가 가장 위험하다** — 배선을 빠뜨린 코드가 막 올라간 시점이다.
  // 큐에 세우지 않는다: 기동 따라잡기(판정, 수 분) 뒤에 서면 그동안 검수가 꺼진 채로 돈다
  canaryTick();
}

async function main(): Promise<void> {
  // **경고만 한다 — 부팅을 막지 않는다.** pm2 재시작이면 이 심박은 방금 죽은 자기
  // 자신의 것이라, 여기서 종료하면 정상 배포가 크래시 루프가 된다
  // (제대로 된 상호배제는 Postgres advisory lock — schedulerHealth 주석)
  if (await anotherSchedulerMayBeRunning(prisma)) {
    console.warn(
      '⚠ 최근 심박이 있습니다 — 방금 재시작한 것이면 정상입니다.\n' +
        '  두 대가 동시에 도는 것이라면 KIS 토큰(분당 1회)에서 서로를 죽입니다. pm2 status로 확인하세요.',
    );
  }

  console.log(
    '스케줄러 시작 — 마감+5분 판정 / 장중 2분 감시 갱신 / 04:00 백업 / 06:00 마스터 동기화',
  );
  for (const market of MARKETS) {
    const day = marketToday(market, new Date());
    const holiday = holidayName(market, day);
    console.log(
      `  ${market} ${day}: ${holiday ? `휴장 (${holiday})` : '거래일'}` +
        ` / 달력 잔여 ${coverageEndsIn(market, day)}일`,
    );
  }
  // **일과 기록을 먼저 읽는다.** 이게 없으면 재기동할 때마다 오늘 이미 돈 일을
  // 다시 돈다 — 백업이 하루 세 번 뜨고, 마스터 동기화가 배포마다 KIS를 두드린다
  await loadJobHistory();

  catchUpOnBoot();
  tick();
}

void main();
const timer = setInterval(tick, TICK_MS);
// 심박은 큐와 별개의 타이머다 — 큐가 막혀도 "프로세스는 살아 있다"를 계속 말한다
const beatTimer = setInterval(beat, BEAT_INTERVAL_MS);
beat();
// 카나리아도 큐와 별개의 타이머다 (회신 15호 §1). 기동 1회는 catchUpOnBoot 가 친다
const canaryTimer = setInterval(canaryTick, CANARY_INTERVAL_MS);
// IRIS 출근 점검은 카나리아와 **주기의 절반만큼 어긋나게** 시작한다 (회신 16호 §1-1) —
// 기동 때 그만큼 늦게 첫 회를 치고 이후 같은 주기. 벽시계 나머지가 아니라 재기동해도 간격이 남는다
let attendanceTimer: NodeJS.Timeout | null = null;
/* **예약했다는 사실을 찍는다** — 첫 점검이 2분 30초 뒤라, 그 사이 `lastRan` 은 직전
   실행 때의 값이다. 이것이 없으면 화면의 출근 점검 칸이 그동안 ✗ 로 보인다.
   ⚠ **알림을 막는 것은 이 줄이 아니다** — 그 몫은 `beat()` 의 부팅 창구 하나가 진다
   (BOOT_AT 주석). 처음에는 이 줄로 막으려 했는데 `beat()` 가 여덟 줄 위에서 이미
   돌아 한 번도 닿지 못했다. **같은 일을 두 곳에서 하지 않는다** — 여기는 화면만 맡는다. */
if (studentClient) void markAttendanceTimerScheduled(prisma);
const attendanceStart = setTimeout(() => {
  attendanceTick();
  attendanceTimer = setInterval(attendanceTick, STUDENT_ATTENDANCE_INTERVAL_MS);
}, STUDENT_ATTENDANCE_OFFSET_MS);

function shutdown(how: string): void {
  if (stopping) return;
  clearInterval(timer);
  clearInterval(beatTimer); // 지운 심박을 다음 주기가 되살리면 안 된다
  clearInterval(canaryTimer);
  clearTimeout(attendanceStart);
  if (attendanceTimer) clearInterval(attendanceTimer);
  // 남은 큐를 버린다 — 진행 중인 것 하나만 끝내고 나간다 (stopping 주석 참고).
  // 이래야 pm2의 kill_timeout 안에 끝나고, 그래야 아래 clearHeartbeat이 실제로 돈다
  stopping = true;
  console.log(`스케줄러 종료(${how}) — 진행 중인 배치만 끝내고 나갑니다`);
  // 심박을 지운다 — 안 지우면 헬스 엔드포인트가 문턱만큼 "살아 있다"고 답한다
  void queue
    .finally(() => clearHeartbeat(prisma))
    .finally(() => prisma.$disconnect().then(() => process.exit(0)));
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => shutdown(sig));
}

// **윈도우에는 신호가 없다.** POSIX 시그널이 없어 pm2가 TerminateProcess로 프로세스를
// 끊으므로 위의 SIGTERM 핸들러는 **한 번도 실행되지 않는다** — 실측으로 확인했다
// (정상 종료 로그가 안 찍히고 심박이 남아, 멈춘 스케줄러를 헬스 엔드포인트가 15분간
// "살아 있다"고 답했다). pm2의 우회로는 신호 대신 IPC 메시지다
// (ecosystem.config.cjs의 shutdown_with_message).
process.on('message', (m) => {
  if (m === 'shutdown') shutdown('IPC');
});
