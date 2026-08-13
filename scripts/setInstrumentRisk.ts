import { PrismaClient } from '@prisma/client';
import {
  formatMarketCap,
  instrumentRiskReasons,
  MIN_MARKET_CAP,
  RISK_LEVELS,
  RISK_SOURCE_NOTE,
  type RiskLevel,
} from '../src/domain/instrumentRisk';
import { setInstrumentRisk } from '../src/server/instrumentService';
import type { AssetClass } from '../src/domain/constants';

// 종목 위험 정보 등록/해제:
//   npm run risk:set -- <자산군> <티커> <등급> ["사유"] [--delisting] [--cap=<시가총액>]
//   npm run risk:set -- KR_EQUITY 005930 WARNING "KRX 투자경고 지정"
//   npm run risk:set -- KR_EQUITY 123456 CAUTION "관리종목 지정" --delisting --cap=45000000000
//   npm run risk:set -- KR_EQUITY 005930 NONE --no-delisting   (해제)
//   npm run risk:set -- --list                                  (현재 지정 목록)
//   npm run risk:set -- --judgeable KR_EQUITY 005930            (판정 불가 해제)
//
// **판정 불가(unjudgeableAt)는 위험 등급과 다른 칸이다.** 등급은 거래소가 지정한
// 사실이고, 판정 불가는 우리 시세 소스가 그 티커를 못 주는 것이다. 시세 소스를 고쳤을
// 때 되돌리는 경로가 여기다 — 자동으로는 절대 풀리지 않는다(같은 실패를 반복하지 않게).
//
// 등급·상폐 가능성·과소 시총은 모두 게시 보류(운영자 큐)를 유발한다.
// DANGER만 즉시 차단 — 이미 거래가 중단된 종목이라 승인해도 판정이 불가능하기 때문.
//
// 코인은 종목 동기화가 업비트 시장 경보를 자동 반영하므로 수동 등록이 필요 없다.
// 국내·미국 주식은 시세 공급자가 시장경보를 주지 않아 당분간 이 경로로 채운다
// (KRX 시장경보·관리종목 자동 수집은 소스 확정 후 어댑터로 대체 예정).

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const rows = await prisma.instrument.findMany({
      where: { OR: [{ riskLevel: { not: 'NONE' } }, { unjudgeableAt: { not: null } }] },
      select: {
        assetClass: true,
        ticker: true,
        name: true,
        riskLevel: true,
        riskNote: true,
        unjudgeableAt: true,
        unjudgeableNote: true,
      },
      orderBy: [{ assetClass: 'asc' }, { ticker: 'asc' }],
    });
    if (rows.length === 0) {
      console.log('위험 등급이 지정되거나 판정 불가로 막힌 종목이 없습니다.');
    } else {
      for (const r of rows) {
        // 두 칸을 나란히 찍는다 — 같은 "막힘"이라도 원인이 거래소인지 우리인지 보여야 한다
        console.log(
          `${r.riskLevel.padEnd(8)} ${r.assetClass.padEnd(10)} ${r.ticker.padEnd(10)} ${r.name}` +
            `${r.riskNote ? ` — ${r.riskNote}` : ''}` +
            `${r.unjudgeableAt ? ` [판정 불가 ${r.unjudgeableAt.toISOString().slice(0, 10)}${r.unjudgeableNote ? `: ${r.unjudgeableNote}` : ''}]` : ''}`,
        );
      }
    }
    return;
  }

  // 판정 불가 해제 — 시세 소스를 고친 뒤 사람이 명시적으로 되돌린다
  if (args[0] === '--judgeable') {
    const [ac, tk] = args.slice(1).filter((a) => !a.startsWith('--'));
    if (!ac || !tk) {
      console.error('사용법: npm run risk:set -- --judgeable <자산군> <티커>');
      process.exitCode = 1;
      return;
    }
    const r = await prisma.instrument.update({
      where: { assetClass_ticker: { assetClass: ac, ticker: tk } },
      data: { unjudgeableAt: null, unjudgeableNote: null },
    });
    console.log(`${r.name}(${r.ticker}) → 판정 가능으로 되돌렸습니다 (신규 게시 허용)`);
    return;
  }

  const flags = args.filter((a) => a.startsWith('--'));
  const [assetClass, ticker, level, note] = args.filter((a) => !a.startsWith('--'));
  const capFlag = flags.find((f) => f.startsWith('--cap='));
  const extra: { delistingRisk?: boolean; marketCap?: number | null } = {};
  if (flags.includes('--delisting')) extra.delistingRisk = true;
  if (flags.includes('--no-delisting')) extra.delistingRisk = false;
  if (capFlag) {
    const raw = capFlag.slice('--cap='.length);
    const parsed = raw === 'null' ? null : Number(raw);
    if (parsed !== null && !Number.isFinite(parsed)) {
      console.error(`시가총액이 숫자가 아닙니다: ${raw}`);
      process.exitCode = 1;
      return;
    }
    extra.marketCap = parsed;
  }

  if (!assetClass || !ticker || !level) {
    console.error('사용법: npm run risk:set -- <자산군> <티커> <등급> ["사유"]');
    console.error(`  자산군: KR_EQUITY | US_EQUITY | CRYPTO`);
    console.error(`  등급: ${RISK_LEVELS.join(' | ')}`);
    console.error('  --delisting / --no-delisting: 상장폐지 가능성 표시');
    console.error('  --cap=<숫자>: 시가총액 (종목 통화 기준, null이면 미판단)');
    console.error('\n자산군별 최소 시가총액 (이 미만이면 게시 보류):');
    for (const [ac, floor] of Object.entries(MIN_MARKET_CAP)) {
      console.error(`  ${ac}: ${formatMarketCap(floor, ac as AssetClass)}`);
    }
    console.error('\n위험 정보 원천:');
    for (const [ac, src] of Object.entries(RISK_SOURCE_NOTE)) console.error(`  ${ac}: ${src}`);
    process.exitCode = 1;
    return;
  }
  if (!RISK_LEVELS.includes(level as RiskLevel)) {
    console.error(`알 수 없는 등급: ${level} (${RISK_LEVELS.join(' | ')})`);
    process.exitCode = 1;
    return;
  }

  const updated = await setInstrumentRisk(
    prisma,
    assetClass as AssetClass,
    ticker,
    level as RiskLevel,
    note ?? null,
    extra,
  );
  console.log(
    `${updated.name}(${updated.ticker}) → ${updated.riskLevel}` +
      `${updated.riskNote ? ` (${updated.riskNote})` : ''}` +
      `${updated.delistingRisk ? ' · 상폐 가능성' : ''}` +
      `${updated.marketCap != null ? ` · 시총 ${formatMarketCap(updated.marketCap, assetClass as AssetClass)}` : ''}`,
  );

  if (updated.riskLevel === 'DANGER') {
    console.log('  · 신규 예측 게시가 차단됩니다 (진행 중 카드·판정은 영향 없음)');
    return;
  }
  const reasons = instrumentRiskReasons({
    assetClass: assetClass as AssetClass,
    riskLevel: updated.riskLevel as RiskLevel,
    riskNote: updated.riskNote,
    delistingRisk: updated.delistingRisk,
    marketCap: updated.marketCap,
  });
  if (reasons.length === 0) {
    console.log('  · 게시 제한 없음');
  } else {
    console.log('  · 이 종목의 신규 게시는 보류되어 운영자 검토 큐로 갑니다:');
    for (const r of reasons) console.log(`    - [${r.code}] ${r.message}`);
  }
}

main().finally(() => prisma.$disconnect());
