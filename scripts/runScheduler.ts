import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import type { AssetClass } from '../src/domain/constants';
import { isJustAfterClose, isMarketOpen, marketToday } from '../src/domain/marketHours';
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

async function judgeMarket(assetClass: AssetClass): Promise<void> {
  const reached = await runReachedJudgmentBatch(prisma, registry, new Date(), assetClass);
  const due = await judgeAndSettleDueCards(prisma, registry, new Date(), assetClass);
  const sales = await runSalesCloseBatch(prisma, new Date(), registry, assetClass);
  console.log(
    `  ${assetClass}: 도달 ${reached.judged} / 기한 ${due.judged}(이월 ${due.deferred}) / 판매마감 ${sales.closed.length}`,
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

  // ── 국내 시장경보·거래정지 (매일 07:10 KST) ─────────────
  // 마스터 파일은 관리종목까지만 준다. 투자경고·거래정지·정리매매는 현재가 응답에만
  // 있어 종목당 1회가 필요하므로, **카드가 걸린 종목만** 본다 (server/syncKrRisk 규칙)
  if (kstClock >= '07:10' && kstClock < '08:10' && onceADay('risk:kr', kstNow)) {
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

console.log('스케줄러 시작 — 마감+5분 판정 / 장중 2분 감시 갱신 / 06:00 마스터 동기화');
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
