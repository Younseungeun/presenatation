import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { toRiskLevel, type RiskLevel } from '../src/domain/instrumentRisk';
import {
  fetchUsHalts,
  fetchUsListings,
  financialStatusRisk,
} from '../src/infra/marketData/nasdaqTrader';
import { setInstrumentRisk } from '../src/server/instrumentService';

// 미국 종목 상태 동기화 — npm run risk:us (하루 1회)
//
// KIS 미국 마스터에는 거래정지·상장폐지가 없다(실측). 나스닥이 직접 게시하는 공개
// 파일로 그 구멍을 메운다 — 인증·요율 제한이 없어 전 종목을 한 번에 훑는다.
//   · Financial Status D·E·H·Q → 위험 등급 (상장폐지 심사로 이어지는 상태)
//   · 거래정지 피드 → 재개 공지가 없는 종목은 DANGER
//   · ETF·시험종목 → 비활성 (예측 대상이 아니다)
//
// 등급은 **올리기만 한다** — 운영자가 손으로 올려 둔 경고를 매일 도는 배치가 지우면 안 된다.

const RANK: RiskLevel[] = ['NONE', 'CAUTION', 'WARNING', 'DANGER'];

async function main() {
  const prisma = new PrismaClient();
  const [listings, halts] = await Promise.all([fetchUsListings(), fetchUsHalts()]);
  console.log(`나스닥 공개 파일: 상장 ${listings.length}종 / 거래정지 ${halts.length}건`);

  // 우리 유니버스에 있는 종목만 본다 — 나스닥 전체를 DB에 밀어 넣지 않는다
  const ours = new Map(
    (
      await prisma.instrument.findMany({
        where: { assetClass: 'US_EQUITY' },
        select: { ticker: true, riskLevel: true, active: true },
      })
    ).map((r) => [r.ticker, r]),
  );

  let raised = 0;
  let kept = 0;
  let deactivated = 0;

  for (const l of listings) {
    const mine = ours.get(l.ticker);
    if (!mine) continue;

    // ETF·시험종목은 예측 대상이 아니다 (KIS 증권종류로 이미 걸렀지만 출처가 둘이면 더 안전하다)
    if ((l.etf || l.testIssue) && mine.active) {
      await prisma.instrument.updateMany({
        where: { assetClass: 'US_EQUITY', ticker: l.ticker },
        data: { active: false },
      });
      deactivated++;
      continue;
    }

    const signal = financialStatusRisk(l.financialStatus);
    if (!signal) continue;
    const next = toRiskLevel(signal);
    if (RANK.indexOf(next) < RANK.indexOf(mine.riskLevel as RiskLevel)) {
      kept++;
      continue;
    }
    if (next === mine.riskLevel) continue;
    await setInstrumentRisk(prisma, 'US_EQUITY', l.ticker, next, signal.note ?? null, {
      delistingRisk: signal.delisting,
    });
    raised++;
    console.log(`  ↑ ${l.ticker}: ${mine.riskLevel} → ${next} (${signal.note})`);
  }

  // 거래정지 — 재개 공지가 없는 건만 (당일 재개된 것은 정상으로 둔다)
  let halted = 0;
  for (const h of halts.filter((x) => !x.resumptionDate)) {
    const mine = ours.get(h.ticker);
    if (!mine) continue;
    await setInstrumentRisk(prisma, 'US_EQUITY', h.ticker, 'DANGER', `거래정지 (${h.reasonCode})`, {
      delistingRisk: false,
    });
    halted++;
    console.log(`  ⏸ ${h.ticker}: 거래정지 ${h.reasonCode}`);
  }

  console.log(`완료 — 등급 상향 ${raised} / 거래정지 ${halted} / 비활성 ${deactivated} / 수동값 유지 ${kept}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
