import 'dotenv/config';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { isJustAfterClose, isMarketOpen, isTradingDay, marketToday } from '../src/domain/marketHours';
import { coverageEndsIn, holidayName } from '../src/domain/marketCalendar';
import { BatchLockBusy, withBatchLock, type BatchFence } from '../src/server/batchLock';
import { backupDatabase } from '../src/server/dbBackup';
import { createDefaultRegistry } from '../src/infra/marketData/registry';
import { toRiskLevel, type RiskLevel } from '../src/domain/instrumentRisk';
import { fetchUsHalts, fetchUsListings, financialStatusRisk } from '../src/infra/marketData/nasdaqTrader';
import { setInstrumentRisk, syncAllInstruments } from '../src/server/instrumentService';
import { judgeAndSettleDueCards } from '../src/server/judgmentBatch';
import { runReachedJudgmentBatch } from '../src/server/reachedJudgmentBatch';
import { runSalesCloseBatch } from '../src/server/salesCloseService';
import { refreshWatchedQuotes } from '../src/server/quoteWatchService';
import { takeMarketSnapshot } from '../src/server/marketStats';
import { runComplianceOps } from '../src/server/complianceOpsService';
import { purgeOldNotifications } from '../src/server/opsAlert';
import {
  anotherSchedulerMayBeRunning,
  BEAT_INTERVAL_MS,
  clearHeartbeat,
  writeHeartbeat,
} from '../src/server/schedulerHealth';
import { seasonOf } from '../src/server/scoreService';
import { purgeExpiredPaymentIntents } from '../src/server/paymentIntentService';
import { sweepStuckRefundAttempts } from '../src/server/settlementOpsService';
import { recalcSeasonTiers } from '../src/server/seasonRecalcService';
import { syncKrCardInstrumentRisk } from '../src/server/krRiskSync';
import { healMissingCardData } from '../src/server/cardDataHealer';
import { JUDGMENT_HARD_CAP_DAYS, STALE_DEFER_DAYS } from '../src/server/judgmentBatch';

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

async function judgeMarketLocked(assetClass: AssetClass, lock: BatchFence): Promise<void> {
  // **자격 검사를 쓰기마다 들려 보낸다** — 락을 뺏긴 뒤 깨어난 프로세스가 남은 카드를
  // 계속 쓰는 것을 막는 유일한 장치다 (batchLock 상단 "펜싱 토큰" 주석)
  const reached = await runReachedJudgmentBatch(prisma, registry, new Date(), assetClass, lock.fence);

  // **밀린 카드를 다 소진할 때까지 커서로 이어서 돈다.** 판정은 한 회차 20장으로 끊기는데
  // (JUDGE_BATCH_SIZE — KIS 호출 간격 1.1초 때문에 한 번에 다 하면 큐가 통째로 막힌다),
  // 분기말처럼 시한이 몰린 날 20장만 하고 내일로 넘기면 정산이 하루씩 밀린다.
  //
  // **커서가 없으면 이월 카드가 앞자리를 영구히 막는다** — 이월은 Judgment를 안 만들어
  // 다음 조회에도 그대로 잡히기 때문이다. 그러면 뒤의 멀쩡한 카드가 영영 판정되지 않는다
  const due = await judgeAndSettleDueCards(prisma, registry, new Date(), assetClass, undefined, lock.fence);
  let chunks = 1;
  while (due.hasMore && due.cursor && chunks < MAX_JUDGE_CHUNKS && !stopping) {
    const next = await judgeAndSettleDueCards(
      prisma,
      registry,
      new Date(),
      assetClass,
      due.cursor,
      lock.fence,
    );
    due.judged += next.judged;
    due.deferred += next.deferred;
    due.failed += next.failed;
    due.staleDeferred.push(...next.staleDeferred);
    due.hardCapped.push(...next.hardCapped);
    due.blockedInstruments.push(...next.blockedInstruments);
    due.failures.push(...next.failures);
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
    `  ${assetClass}: 도달 ${reached.judged} / 기한 ${due.judged}(이월 ${due.deferred}, ${chunks}회차) / 판매마감 ${sales.closed.length}`,
  );

  // **이월이 오래된 카드는 사람이 봐야 한다.** 지금까지 이 목록은 배치 로그에만 남아
  // 아무도 읽지 않았다 — 돈이 묶인 카드가 조용히 방치되는 경로다
  // **시스템이 끝낸 건은 사람이 반드시 알아야 한다** — 전액 환불이 이미 나갔고,
  // 리서처에게는 자기 잘못이 아닌 판정 불가가 기록됐다. 조용히 지나가면 안 되는 사건이다
  if (due.hardCapped.length > 0) {
    await notifyOperators(
      `[확인] 판정 상한 도달 ${due.hardCapped.length}건 — 판정 불가·전액 환불 처리됨`,
      `시한 후 ${JUDGMENT_HARD_CAP_DAYS}일이 지나도록 시세를 구하지 못해 시스템이 닫았습니다.\n` +
        `시세 소스 문제인지 확인하고, 반복되면 소스를 바꿔야 합니다.\n` +
        due.hardCapped.slice(0, 10).join('\n'),
      '/admin/judgments',
    );
  }

  // **유니버스가 줄어든 사건이다.** 리서처는 다음 게시에서야 알게 되므로, 원인이
  // 시세 소스 쪽이면 사람이 먼저 풀어야 한다 (`npm run risk:set`으로 되돌린다)
  if (due.blockedInstruments.length > 0) {
    await notifyOperators(
      `[확인] 판정 불가 반복 종목 ${due.blockedInstruments.length}건 — 신규 게시 중단`,
      `같은 종목에서 판정 불가가 반복돼 신규 카드 게시를 막았습니다.\n` +
        `진행 중인 카드와 돈은 그대로입니다. 시세 소스 문제라면 고친 뒤 등급을 되돌리세요.\n` +
        due.blockedInstruments.join('\n'),
      '/admin/judgments',
    );
  }

  // **예상 밖 오류에는 다른 발견 경로가 없다.** 이월은 정차 큐가, 상한은 전용 알림이
  // 받아 주지만 이건 콘솔에만 남았었다 — 그러는 동안 그 카드의 돈은 에스크로에 잠겨 있다.
  // 데이터가 아니라 코드 문제라 기다린다고 낫지 않는다
  if (due.failures.length > 0) {
    await notifyOperators(
      `[버그] 판정 오류 ${due.failures.length}건 — 코드 확인 필요`,
      `시세 미도달이 아니라 **예상 밖 오류**로 판정하지 못한 카드입니다.\n` +
        `기다린다고 낫지 않으니 로그를 보고 고쳐야 합니다. 고칠 때까지 에스크로가 잠깁니다.\n` +
        due.failures.slice(0, 10).join('\n'),
      '/admin/judgments',
    );
  }

  if (due.staleDeferred.length > 0) {
    await notifyOperators(
      `판정 이월 ${due.staleDeferred.length}건 — 수동 확인 필요`,
      `${STALE_DEFER_DAYS}일 넘게 판정되지 못한 카드입니다. 운영자 판정 큐에서 처리하세요.\n` +
        due.staleDeferred.slice(0, 10).join('\n'),
      '/admin/judgments',
    );
  }
}

/** 운영자 전원에게 알림 — 사람이 개입해야 하는 일을 콘솔에만 남기지 않는다 */
async function notifyOperators(title: string, body: string, link: string): Promise<void> {
  const operators = await prisma.user.findMany({
    where: { role: 'OPERATOR' },
    select: { id: true },
  });
  if (operators.length === 0) return;
  await prisma.notification.createMany({
    data: operators.map((o) => ({ userId: o.id, type: 'OPS_ALERT', title, body, link })),
  });
}

function tick(): void {
  const now = new Date();

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
      notifyOperators(
        `거래일 달력 갱신 필요 — ${market}`,
        left < 0
          ? `${market} 휴장일 달력이 ${-left}일 전에 끝났습니다. 지금은 공휴일도 거래일로 취급해 배치가 헛돕니다. src/domain/marketCalendar.ts에 다음 연도 휴장일을 추가해주세요.`
          : `${market} 휴장일 달력이 ${left}일 뒤 끝납니다. src/domain/marketCalendar.ts에 다음 연도 휴장일을 추가해주세요.`,
        '/admin',
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
    });
  }

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
    }
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
function beat(): void {
  void writeHeartbeat(prisma, current);
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

function shutdown(how: string): void {
  if (stopping) return;
  clearInterval(timer);
  clearInterval(beatTimer); // 지운 심박을 다음 주기가 되살리면 안 된다
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
