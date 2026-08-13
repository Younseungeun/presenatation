import 'dotenv/config';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { isJustAfterClose, isMarketOpen, isTradingDay, marketToday } from '../src/domain/marketHours';
import { coverageEndsIn, holidayName } from '../src/domain/marketCalendar';
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
import { sweepStuckRefundAttempts } from '../src/server/settlementOpsService';
import { recalcSeasonTiers } from '../src/server/seasonRecalcService';
import { syncKrCardInstrumentRisk } from '../src/server/krRiskSync';
import { healMissingCardData } from '../src/server/cardDataHealer';
import { STALE_DEFER_DAYS } from '../src/server/judgmentBatch';

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

/** 하루 한 번짜리 일을 "그 시장 날짜" 기준으로 기억한다 — 자정 넘김·재시작에 안전하다 */
const doneOn = new Map<string, string>();
function onceADay(key: string, day: string): boolean {
  if (doneOn.get(key) === day) return false;
  doneOn.set(key, day);
  return true;
}

let lastQuoteAt = 0;

/** 모든 일이 이 큐를 지난다 — 동시에 두 배치가 KIS를 두드리지 않게 */
let queue: Promise<unknown> = Promise.resolve();
function enqueue(label: string, fn: () => Promise<void>): void {
  queue = queue
    .then(async () => {
      const t0 = Date.now();
      try {
        await fn();
        console.log(`[${new Date().toISOString()}] ${label} 완료 (${Date.now() - t0}ms)`);
      } catch (e) {
        console.error(`[${new Date().toISOString()}] ${label} 실패:`, (e as Error).message);
      }
    })
    .catch(() => undefined);
}

/** 한 회차가 아무리 밀려도 이만큼만 — 무한 루프 방지 (20장 × 40 = 800장) */
const MAX_JUDGE_CHUNKS = 40;

async function judgeMarket(assetClass: AssetClass): Promise<void> {
  const reached = await runReachedJudgmentBatch(prisma, registry, new Date(), assetClass);

  // **밀린 카드를 다 소진할 때까지 커서로 이어서 돈다.** 판정은 한 회차 20장으로 끊기는데
  // (JUDGE_BATCH_SIZE — KIS 호출 간격 1.1초 때문에 한 번에 다 하면 큐가 통째로 막힌다),
  // 분기말처럼 시한이 몰린 날 20장만 하고 내일로 넘기면 정산이 하루씩 밀린다.
  //
  // **커서가 없으면 이월 카드가 앞자리를 영구히 막는다** — 이월은 Judgment를 안 만들어
  // 다음 조회에도 그대로 잡히기 때문이다. 그러면 뒤의 멀쩡한 카드가 영영 판정되지 않는다
  const due = await judgeAndSettleDueCards(prisma, registry, new Date(), assetClass);
  let chunks = 1;
  while (due.hasMore && due.lastId && chunks < MAX_JUDGE_CHUNKS) {
    const next = await judgeAndSettleDueCards(
      prisma,
      registry,
      new Date(),
      assetClass,
      due.lastId,
    );
    due.judged += next.judged;
    due.deferred += next.deferred;
    due.failed += next.failed;
    due.staleDeferred.push(...next.staleDeferred);
    due.lastId = next.lastId ?? due.lastId;
    due.hasMore = next.hasMore;
    chunks += 1;
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
  for (const market of MARKETS) {
    if (!isJustAfterClose(market, now)) continue;
    if (!onceADay(`judge:${market}`, marketToday(market, now))) continue;
    enqueue(`${market} 마감 판정`, () => judgeMarket(market));
  }

  // 코인은 마감이 없다 — 한국 시각 09:05에 하루 한 번 (국내 개장 전에 끝난다)
  const kstNow = marketToday('KR_EQUITY', now);
  const kstClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  if (kstClock >= '09:05' && kstClock < '10:05' && onceADay('judge:CRYPTO', kstNow)) {
    enqueue('코인 일일 판정', () => judgeMarket('CRYPTO'));
  }

  // ── 거래일 달력 만료 경고 (매주 1회) ────────────────────
  // 달력이 끝나면 그 뒤 공휴일은 조용히 거래일로 취급된다 — 배치가 헛돌 뿐이지만
  // 아무도 모른 채 넘어가므로, 만료 30일 전부터 주 1회 운영자에게 알린다
  const weekKey = Math.floor(Date.parse(`${kstNow}T00:00:00Z`) / (7 * 86_400_000));
  for (const market of MARKETS) {
    const left = coverageEndsIn(market, marketToday(market, now));
    if (left > 30 || !onceADay(`calendar:${market}:${weekKey}`, kstNow)) continue;
    enqueue('거래일 달력 만료 경고', () =>
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
  if (kstClock >= '04:00' && kstClock < '05:00' && onceADay('backup', kstNow)) {
    enqueue('DB 백업', async () => {
      const r = await backupDatabase();
      console.log(`  ${path.basename(r.file)} — ${(r.bytes / 1_048_576).toFixed(1)}MB / 리포트 ${r.reports}건`);
    });
  }

  // ── 종목 마스터 동기화 (정적 파일 — 호출 제한 무관) ─────
  if (kstClock >= '06:00' && kstClock < '07:00' && onceADay('sync:instruments', kstNow)) {
    enqueue('종목 마스터 동기화', async () => {
      const results = await syncAllInstruments(prisma, registry);
      for (const r of results) {
        console.log(`  ${r.assetClass}: ${r.upserted}종 (비활성 ${r.deactivated})`);
      }
    });
    // 미국 상태는 나스닥 공개 파일에서 온다 (KIS가 주지 않는다) — 같은 시간대에 이어서.
    // 인증·요율 제한이 없어 전 종목을 한 번에 훑는다
    enqueue('미국 종목 상태(나스닥)', async () => {
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
        const current = ours.get(l.ticker);
        if (!current) continue;
        const signal = financialStatusRisk(l.financialStatus);
        if (!signal) continue;
        const next = toRiskLevel(signal);
        // 등급은 올리기만 한다 — 운영자가 올려 둔 경고를 배치가 지우면 안 된다
        if (RISK_RANK.indexOf(next) <= RISK_RANK.indexOf(current as RiskLevel)) continue;
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
  if (kstClock.endsWith(':00') && onceADay(`snapshot:${kstClock}`, kstNow)) {
    enqueue('마켓 스냅샷', async () => {
      await takeMarketSnapshot(prisma);
    });
  }

  // ── 보류 큐 운영 (매일 07:00 KST) ───────────────────────
  // 이 배치가 없으면 컴플라이언스 보류 큐는 운영자가 열어볼 때까지 아무 일도 일어나지
  // 않는 블랙홀이 된다 (시한 경과 건의 초안 복귀·운영자 알림이 여기서 난다)
  if (kstClock >= '07:00' && kstClock < '08:00' && onceADay('compliance', kstNow)) {
    enqueue('보류 큐 운영', async () => {
      const s = await runComplianceOps(prisma);
      console.log(`  시한 경과 초안 복귀 ${s.expired.length}건`);
    });
  }

  // ── 방치된 환불 시도 (30분마다) ─────────────────────────
  // PENDING은 "취소가 나갔는지 우리가 모른다"는 뜻인데, 그 행을 아무도 다시 보지 않으면
  // 구매자 환불이 조용히 멈춘 채 남는다. 정산 큐에는 보이지만 큐를 안 열면 그만이다.
  // 건마다 알리면 소음이라 배치가 묶어서 한 번에 올린다(이미 알린 건은 다시 안 센다)
  if (kstClock.endsWith(':00') || kstClock.endsWith(':30')) {
    if (onceADay(`refund-sweep:${kstClock}`, kstNow)) {
      enqueue('방치된 환불 시도 점검', async () => {
        const s = await sweepStuckRefundAttempts(prisma);
        if (s.stuck > 0) console.log(`  끝나지 않은 환불 시도 ${s.stuck}건 — 운영자에게 알림`);
      });
    }
  }

  // ── 국내 시장경보·거래정지 (매일 07:10 KST) ─────────────
  // 마스터 파일은 관리종목까지만 준다. 투자경고·거래정지·정리매매는 현재가 응답에만
  // 있어 종목당 1회가 필요하므로, **카드가 걸린 종목만** 본다 (server/syncKrRisk 규칙)
  // 휴장일은 건너뛴다 — 시장경보 지정은 거래일에만 바뀐다
  if (
    kstClock >= '07:10' &&
    kstClock < '08:10' &&
    isTradingDay('KR_EQUITY', now) &&
    onceADay('risk:kr', kstNow)
  ) {
    enqueue('국내 종목 경보 갱신', async () => {
      const s = await syncKrCardInstrumentRisk(prisma, registry);
      console.log(`  대상 ${s.checked}종목 — 상향 ${s.raised} / 수동값 유지 ${s.keptManual}`);
    });
  }

  // ── 결측값 치유 (매일 07:20 KST) ────────────────────────
  // 게시 때 시세가 잠깐 흔들려 σ·앵커가 빈 카드를 메운다. 안 하면 그 카드는 판정까지
  // 안정성 "—"에 분할 감지도 안 된다
  if (kstClock >= '07:20' && kstClock < '08:20' && onceADay('heal', kstNow)) {
    enqueue('카드 결측값 치유', async () => {
      const s = await healMissingCardData(prisma, registry);
      if (s.sigmaFilled + s.anchorFilled > 0) {
        console.log(`  σ ${s.sigmaFilled} / 앵커 ${s.anchorFilled} 채움 (실패 ${s.failed})`);
      }
    });
  }

  // ── 분기 시즌 재산정 (1/4/7/10월 1일 00:10 KST) ─────────
  // 등급 승급·강등이 일어나는 유일한 자리다. 빠져 있으면 등급이 영원히 고정된다
  const [mm, dd] = kstNow.split('-').slice(1);
  if (
    ['01', '04', '07', '10'].includes(mm) &&
    dd === '01' &&
    kstClock >= '00:10' &&
    kstClock < '01:10' &&
    onceADay('season', kstNow)
  ) {
    enqueue('분기 시즌 재산정', async () => {
      const s = await recalcSeasonTiers(prisma);
      console.log(
        `  ${s.season}: 평가 ${s.evaluated}명 — 승급 ${s.promoted} / 강등 ${s.demoted}`,
      );
    });
  }
}

/**
 * 기동 직후 한 번 따라잡기.
 *
 * 판정은 "마감 +5분부터 한 시간" 창구에서만 돈다. 그 시간에 스케줄러가 꺼져 있었으면
 * 그날 판정이 통째로 비고, 다음 창구까지 하루가 밀린다. 그래서 시작할 때 **시장을
 * 가리지 않고 한 번** 돌려 밀린 것을 정리한다 (판정은 멱등이라 중복 실행이 안전하다).
 */
function catchUpOnBoot(): void {
  enqueue('기동 따라잡기', async () => {
    for (const assetClass of ['KR_EQUITY', 'US_EQUITY', 'CRYPTO'] as AssetClass[]) {
      await judgeMarket(assetClass);
    }
  });
}

console.log('스케줄러 시작 — 마감+5분 판정 / 장중 2분 감시 갱신 / 04:00 백업 / 06:00 마스터 동기화');
for (const market of MARKETS) {
  const day = marketToday(market, new Date());
  const holiday = holidayName(market, day);
  console.log(
    `  ${market} ${day}: ${holiday ? `휴장 (${holiday})` : '거래일'}` +
      ` / 달력 잔여 ${coverageEndsIn(market, day)}일`,
  );
}
catchUpOnBoot();
tick();
const timer = setInterval(tick, TICK_MS);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    clearInterval(timer);
    console.log('스케줄러 종료 — 진행 중인 배치를 기다립니다');
    void queue.finally(() => prisma.$disconnect().then(() => process.exit(0)));
  });
}
