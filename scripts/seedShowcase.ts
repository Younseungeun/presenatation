import { PrismaClient } from '@prisma/client';
import type { DailyQuote, ProviderRegistry } from '../src/domain/marketData';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import { minMagnitudePct } from '../src/domain/scoring';
import { createDraftReport, publishReport } from '../src/server/reportService';
import { purchaseReport } from '../src/server/purchaseService';
import { TIERS } from '../src/domain/constants';

/**
 * **관리자 앱이 진짜로 도는지 보기 위한 시드** — npm run seed:showcase
 *
 * `seedAdminCases` 와 목적이 다르다. 저쪽은 **화면이 그려야 할 모양**을 직접 만들어
 * 빈 상자를 없애는 것이고(그래서 서비스 함수를 타지 않는다), 이쪽은 **실제 파이프라인을
 * 통과시킨다** — `publishReport` 가 검수를 돌리고, 그 결과로 게시·보류·거절이 갈린다.
 *
 * 그래서 여기서 만든 보류 건은 "보류처럼 보이는 행"이 아니라 **규칙 엔진이 실제로 잡은 건**이다.
 * 운영자가 승인을 누르면 진짜 승인 경로가 돌고, 반려하면 진짜 사전 등록이 열린다.
 *
 * ── 무엇을 덮나 ────────────────────────────────────────────────
 * · 등급 5종 리서처 (무표기·시니어·마스터·펠로우·인투빌 펠로우)
 * · 자산군 3종 (국내주식·미국주식·코인)
 * · 검수 세 갈래 — 통과 게시 / 규칙 WARN 보류 / 규칙 BLOCK 즉시 거절
 * · 별점 스펙트럼 — 신뢰도 2~10, 크기(수익성)를 하한의 1.1~5배로 흩어 놓는다
 * · 구매·에스크로 / 신고 / 정산 계좌 + 동결
 *
 * ── 시세는 픽스처다 ─────────────────────────────────────────────
 * 외부 호출 없이 결정적으로 돈다. 다만 **크기 하한은 지어내지 않는다** —
 * `minMagnitudePct` 를 그대로 불러 그 위를 고른다. 하한식이 바뀌면 이 시드도 따라 움직인다
 * (옛 시나리오 시드들이 하드코딩 때문에 전부 게시에 실패한 자리다).
 */

const prisma = new PrismaClient();
const DAY = 86_400_000;
const MARK = '[展]'; // 이 시드가 만든 것 — 나중에 골라 지울 수 있게

type Spec = {
  assetClass: 'KR_EQUITY' | 'US_EQUITY' | 'CRYPTO';
  ticker: string;
  name: string;
  base: number;
  /** 하루 변동폭 — σ 를 결정한다 (안정성 별점이 여기서 나온다) */
  vol: number;
};

const SPECS: Spec[] = [
  { assetClass: 'KR_EQUITY', ticker: '005930', name: '삼성전자', base: 71_000, vol: 0.015 },
  { assetClass: 'KR_EQUITY', ticker: '000660', name: 'SK하이닉스', base: 180_000, vol: 0.028 },
  { assetClass: 'US_EQUITY', ticker: 'AAPL', name: '애플', base: 230, vol: 0.013 },
  { assetClass: 'US_EQUITY', ticker: 'NVDA', name: '엔비디아', base: 140, vol: 0.032 },
  { assetClass: 'CRYPTO', ticker: 'KRW-BTC', name: '비트코인', base: 100_000_000, vol: 0.025 },
  { assetClass: 'CRYPTO', ticker: 'KRW-ETH', name: '이더리움', base: 4_500_000, vol: 0.038 },
];

/** 결정적 난수 — 같은 시드는 언제나 같은 데이터를 만든다 */
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 160거래일치 일봉 — σ 측정(120일)에 넉넉하다 */
function series(spec: Spec, endAt: Date): DailyQuote[] {
  const rnd = mulberry32(spec.ticker.split('').reduce((a, c) => a + c.charCodeAt(0), 7));
  const out: DailyQuote[] = [];
  let price = spec.base;
  for (let i = 160; i >= 0; i--) {
    const d = new Date(endAt.getTime() - i * DAY);
    // 주말은 건너뛴다 — 주식은 거래일만 있어야 σ 창이 맞는다
    if (spec.assetClass !== 'CRYPTO' && (d.getUTCDay() === 0 || d.getUTCDay() === 6)) continue;
    const step = (rnd() - 0.5) * 2 * spec.vol;
    price = Math.max(spec.base * 0.4, price * (1 + step));
    const close = spec.assetClass === 'CRYPTO' ? Math.round(price) : Math.round(price / 10) * 10;
    out.push({
      date: ymd(d),
      open: close,
      high: Math.round(close * (1 + spec.vol / 2)),
      low: Math.round(close * (1 - spec.vol / 2)),
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

function registry(specs: Spec[], endAt: Date): ProviderRegistry {
  const reg: ProviderRegistry = {};
  for (const s of specs) {
    const p = (reg[s.assetClass] as FixtureMarketDataProvider | undefined) ?? new FixtureMarketDataProvider();
    const q = series(s, endAt);
    p.setQuotes(s.ticker, q);
    (p as unknown as { setCurrentPrice?(t: string, v: number): void }).setCurrentPrice?.(
      s.ticker,
      q[q.length - 1].close,
    );
    reg[s.assetClass] = p;
  }
  return reg;
}

/** 검수가 갈라지는 세 가지 본문 — 규칙 엔진이 실제로 판단한다 */
const BODIES = {
  clean:
    '최근 분기 실적과 업황 지표를 함께 놓고 보면 수요 회복이 이어질 가능성이 있습니다. ' +
    '다만 환율과 재고 수준에 따라 결과가 달라질 수 있어 비중 조절이 필요합니다.',
  warn:
    '업계에서는 신규 수주가 임박했다는 소문에 의하면 분위기가 좋다고 합니다. ' +
    '지금 빚투로라도 들어가야 한다는 이야기가 돌고 있어 흐름을 정리했습니다.',
  block:
    '이 구간에서는 원금 보장 수준으로 안전하다고 판단합니다. ' +
    '자세한 문의는 카카오톡으로 주시면 개별 안내드리겠습니다.',
};

async function researcher(tier: string, penName: string) {
  const email = `showcase-${tier.toLowerCase()}@case.local`;
  const found = await prisma.user.findUnique({ where: { email }, include: { researcherProfile: true } });
  if (found?.researcherProfile) {
    await prisma.researcherProfile.update({ where: { id: found.researcherProfile.id }, data: { tier } });
    return found.researcherProfile.id;
  }
  const u = await prisma.user.create({
    data: {
      email,
      penName,
      identityVerified: true,
      researcherProfile: { create: { tier, bio: `${penName} — 등급 확인용 계정` } },
    },
    include: { researcherProfile: true },
  });
  return u.researcherProfile!.id;
}

async function buyer(n: number) {
  const email = `showcase-buyer${n}@case.local`;
  return prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, penName: `구매자${n}`, identityVerified: true },
  });
}

async function main() {
  const now = new Date();
  const reg = registry(SPECS, now);

  console.log('1) 등급 5종 리서처');
  const names = ['신입리서처', '시니어리서처', '마스터리서처', '펠로우리서처', '인투빌펠로우'];
  const rids: string[] = [];
  for (const [i, tier] of TIERS.entries()) {
    rids.push(await researcher(tier, names[i]));
    console.log(`  ${tier} — ${names[i]}`);
  }

  console.log('2) 구매자 3명');
  const buyers = [await buyer(1), await buyer(2), await buyer(3)];

  console.log('3) 리포트 게시 — 검수 파이프라인을 실제로 통과시킨다');
  const kinds: (keyof typeof BODIES)[] = ['clean', 'clean', 'warn', 'block'];
  const published: { reportId: string; priceKrw: number }[] = [];
  let pass = 0;
  let held = 0;
  let rejected = 0;

  for (const [si, spec] of SPECS.entries()) {
    const inst = await prisma.instrument.findFirst({
      where: { ticker: spec.ticker, assetClass: spec.assetClass },
      select: { sigmaDaily: true, name: true },
    });
    for (const [ki, kind] of kinds.entries()) {
      const horizon = [30, 60, 90, 45][ki];
      const floor = minMagnitudePct(spec.assetClass, inst?.sigmaDaily ?? null, horizon);
      // 하한의 1.1~5배로 흩어 놓는다 — 수익성 별점이 1~5로 골고루 나온다
      const magnitude = Number((floor * [1.1, 2.2, 3.4, 5.0][ki]).toFixed(1));
      const confidence = [2, 5, 8, 10][ki]; // 신뢰도 별점 스펙트럼
      // **한 종목의 네 건은 같은 리서처가 낸다** — 선결제 상한이 등급별이라
      // (무표기 0% · 시니어 0% · 마스터 10% · 펠로우 20% · 인투빌 펠로우 30%),
      // 등급을 알아야 통과 가능한 비율을 고를 수 있다. 관문을 피하는 것이 아니라 지키는 것이다
      const tierIdx = si % rids.length;
      const rid = rids[tierIdx];
      const prepaymentCap = ([0, 0, 10, 20, 30] as const)[tierIdx];
      const title = `${MARK} ${spec.name} ${horizon}일 전망 (${kind})`;
      try {
        const draft = await createDraftReport(prisma, {
          researcherId: rid,
          title,
          summary: `${spec.name} ${horizon}일 구간 점검 — 검수 경로 확인용`,
          content: BODIES[kind],
          // 가격은 5,000~50,000원 (무료는 예측 카드가 없는 별도 경로다)
          priceKrw: [7_000, 15_000, 28_000, 45_000][ki],
          prepaymentRatio: prepaymentCap,
          card: {
            assetClass: spec.assetClass,
            ticker: spec.ticker,
            assetName: inst?.name ?? spec.name,
            direction: ki % 2 === 0 ? 'UP' : 'DOWN',
            targetType: 'RETURN_PCT',
            targetValue: magnitude,
            confidence,
            selfStability: 1,
            deadline: new Date(now.getTime() + horizon * DAY),
          },
        });
        await publishReport(prisma, reg, draft.id, rid, now);
        const r = await prisma.report.findUnique({
          where: { id: draft.id },
          select: { status: true, priceKrw: true },
        });
        if (r?.status === 'PUBLISHED') {
          pass++;
          published.push({ reportId: draft.id, priceKrw: r.priceKrw });
        } else {
          held++;
        }
        console.log(`  ${spec.name.padEnd(8)} ${kind.padEnd(5)} → ${r?.status}`);
      } catch (e) {
        rejected++;
        console.log(`  ${spec.name.padEnd(8)} ${kind.padEnd(5)} → 거절: ${(e as Error).message.slice(0, 60)}`);
      }
    }
  }
  console.log(`  게시 ${pass} · 보류 ${held} · 거절 ${rejected}`);

  console.log('4) 구매 — 에스크로가 실제로 잡힌다');
  let bought = 0;
  for (const [i, p] of published.entries()) {
    if (p.priceKrw === 0) continue;
    for (const b of buyers.slice(0, (i % 3) + 1)) {
      try {
        await purchaseReport(prisma, p.reportId, b.id, new Date(now.getTime() + 60_000));
        bought++;
      } catch {
        /* 판매 규칙에 걸리면 건너뛴다 — 그것도 현실적인 상태다 */
      }
    }
  }
  console.log(`  구매 ${bought}건`);

  console.log('5) 신고 — 이용자가 잡은 것');
  // **같은 리포트에 여러 건을 묶는다** — 신고 화면의 판단 단위가 신고가 아니라 리포트다
  const target = published[0];
  if (target) {
    const t = await prisma.report.findUnique({
      where: { id: target.reportId },
      select: { title: true },
    });
    const cats = ['ONE_ON_ONE', 'SOLICIT', 'OUTSIDE_CHANNEL'];
    for (const [i, b] of buyers.entries()) {
      await prisma.abuseReport.create({
        data: {
          reportId: target.reportId,
          reporterId: b.id,
          targetName: t?.title ?? '알 수 없음',
          category: cats[i] ?? 'OTHER',
          detail: `${MARK} 신고 확인용 — ${['개별 상담을 유도했습니다', '외부 채널로 오라고 합니다', '카톡 아이디를 남겼습니다'][i]}`,
          status: 'PENDING',
        },
      });
    }
    console.log(`  신고 3건 (같은 리포트에 묶임 — 판단 단위는 리포트)`);
  }

  // 계좌 상태 네 갈래 — 화면이 각각 다르게 말해야 하는 자리다.
  // 동결은 `frozenAt` 이 있는 것이고, 푸는 것은 운영자뿐이다(거는 것은 본인)
  console.log('6) 정산 계좌 네 상태 · 동결');
  const accounts: { email: string; label: string; data: Record<string, unknown> }[] = [
    {
      email: 'showcase-silver@case.local',
      label: '검증 완료',
      data: { status: 'VERIFIED', verifiedAt: new Date(now.getTime() - 5 * DAY), holderName: '시니어리서처' },
    },
    {
      email: 'showcase-gold@case.local',
      label: '동결됨 (본인이 걺)',
      data: {
        status: 'VERIFIED',
        verifiedAt: new Date(now.getTime() - 9 * DAY),
        holderName: '마스터리서처',
        frozenAt: new Date(now.getTime() - 2 * DAY),
      },
    },
    {
      email: 'showcase-platinum@case.local',
      label: '변경 유예 중 (낯선 기기)',
      data: { status: 'UNVERIFIED', cooldownUntil: new Date(now.getTime() + 30 * 3_600_000) },
    },
    { email: 'showcase-challenger@case.local', label: '미검증', data: { status: 'UNVERIFIED' } },
  ];
  for (const a of accounts) {
    const u = await prisma.user.findUnique({ where: { email: a.email }, select: { id: true } });
    if (!u) continue;
    await prisma.payoutAccount.upsert({
      where: { researcherUserId: u.id },
      update: a.data,
      create: {
        researcherUserId: u.id,
        bankCode: '004',
        accountNumberEnc: 'seed-not-a-real-account',
        accountLast4: String(1000 + accounts.indexOf(a)),
        ...a.data,
      },
    });
    console.log(`  ${a.label}`);
  }

  console.log('\n완료. 전부 [展] 표식이 붙어 있습니다.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
