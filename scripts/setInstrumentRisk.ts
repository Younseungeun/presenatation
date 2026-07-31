import { PrismaClient } from '@prisma/client';
import { RISK_LEVELS, RISK_SOURCE_NOTE, type RiskLevel } from '../src/domain/instrumentRisk';
import { setInstrumentRisk } from '../src/server/instrumentService';
import type { AssetClass } from '../src/domain/constants';

// 종목 위험 등급 등록/해제:
//   npm run risk:set -- <자산군> <티커> <등급> ["사유"]
//   npm run risk:set -- KR_EQUITY 005930 WARNING "KRX 투자경고 지정"
//   npm run risk:set -- KR_EQUITY 005930 NONE          (해제)
//   npm run risk:set -- --list                          (현재 지정 목록)
//
// 코인은 종목 동기화가 업비트 시장 경보를 자동 반영하므로 수동 등록이 필요 없다.
// 국내·미국 주식은 시세 공급자가 시장경보를 주지 않아 당분간 이 경로로 채운다
// (KRX 시장경보·관리종목 자동 수집은 소스 확정 후 어댑터로 대체 예정).

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const rows = await prisma.instrument.findMany({
      where: { riskLevel: { not: 'NONE' } },
      select: { assetClass: true, ticker: true, name: true, riskLevel: true, riskNote: true },
      orderBy: [{ assetClass: 'asc' }, { ticker: 'asc' }],
    });
    if (rows.length === 0) {
      console.log('위험 등급이 지정된 종목이 없습니다.');
    } else {
      for (const r of rows) {
        console.log(
          `${r.riskLevel.padEnd(8)} ${r.assetClass.padEnd(10)} ${r.ticker.padEnd(10)} ${r.name}` +
            `${r.riskNote ? ` — ${r.riskNote}` : ''}`,
        );
      }
    }
    return;
  }

  const [assetClass, ticker, level, note] = args;
  if (!assetClass || !ticker || !level) {
    console.error('사용법: npm run risk:set -- <자산군> <티커> <등급> ["사유"]');
    console.error(`  자산군: KR_EQUITY | US_EQUITY | CRYPTO`);
    console.error(`  등급: ${RISK_LEVELS.join(' | ')}`);
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
  );
  console.log(
    `${updated.name}(${updated.ticker}) → ${updated.riskLevel}` +
      `${updated.riskNote ? ` (${updated.riskNote})` : ''}`,
  );
  if (updated.riskLevel === 'DANGER') {
    console.log('  · 신규 예측 게시가 차단됩니다 (진행 중 카드·판정은 영향 없음)');
  } else if (updated.riskLevel === 'WARNING') {
    console.log('  · 리포트 상세에 경고가 노출되고, 리스크 미고지 시 검수에서 지적됩니다');
  }
}

main().finally(() => prisma.$disconnect());
