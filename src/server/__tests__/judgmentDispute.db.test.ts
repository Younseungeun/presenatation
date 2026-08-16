import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedTestInstruments } from './helpers/testDb';
import type { ProviderRegistry } from '@/domain/marketData';
import { FixtureMarketDataProvider } from '@/infra/marketData/fixtureProvider';
import { judgeAndSettleDueCards } from '../judgmentBatch';
import {
  DISPUTE_WINDOW_DAYS,
  DisputeError,
  fileDispute,
  getOpenDisputes,
  fileResearcherDispute,
  getUpheldPendingRevert,
  resolveDispute,
  settlementIdsWithOpenDispute,
} from '../judgmentDisputeService';
import { revertJudgment } from '../judgmentRevertService';
import { decideApproval } from '../operatorApprovalService';
import { getOpsMetrics } from '../opsMetrics';
import { purchaseReport } from '../purchaseService';
import { createDraftReport, publishReport } from '../reportService';
import { executePayout, getPendingPayouts } from '../settlementOpsService';
import { SETTLEMENT_COOLDOWN_HOURS } from '../settlementCooldown';

// **이 창구가 없으면 구매자가 갈 곳은 카드사뿐이다.**
// 차지백은 우리가 아무것도 못 하는 자리에서 돈이 빠지는 것이라, 그 전에 우리 안에서
// 끝낼 기회를 만드는 것이 이 기능의 존재 이유다.
//
// 설계의 핵심 둘을 시험이 고정한다:
//  ① **접수가 정산을 멈춘다** — 판정이 뒤집힐 수 있는 건에 돈이 나가면 되돌릴 수 없다
//  ② **리서처는 내용을 못 본다** — 넘기는 순간 구매자↔리서처 소통 경로가 된다

let prisma: PrismaClient;
let researcherId: string;
let researcherUserId: string;
let buyerId: string;
let strangerId: string;
let operatorId: string;
let secondOperatorId: string;
let purchaseId: string;

const DRAFT_NOW = new Date('2026-07-11T00:00:00Z');
const PUBLISH_NOW = new Date('2026-07-12T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const BATCH_NOW = new Date('2026-08-02T00:00:00Z');
// 쿨다운이 끝난 뒤 (settlementCooldown) — **상수에서 유도한다.**
// 시각을 손으로 적으면 쿨다운을 조정할 때마다 무관한 시험이 무더기로 깨진다
const EXEC_NOW = new Date(BATCH_NOW.getTime() + (SETTLEMENT_COOLDOWN_HOURS + 1) * 3_600_000);

const registry = (ticker: string): ProviderRegistry => ({
  CRYPTO: new FixtureMarketDataProvider().setCurrentPrice(ticker, 100).setQuotes(ticker, [
    { date: '2026-07-20', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    { date: '2026-08-01', open: 120, high: 120, low: 120, close: 120, volume: 1 },
  ]),
});

beforeAll(async () => {
  prisma = createTestDb('judgment-dispute-');
  await seedTestInstruments(prisma, [
    { assetClass: 'CRYPTO', ticker: 'KRW-DSP', name: 'KRW-DSP', shortable: true },
  ]);
  const r = await prisma.user.create({
    data: { email: 'r@dsp.io', identityVerified: true, researcherProfile: { create: {} } },
    include: { researcherProfile: true },
  });
  researcherId = r.researcherProfile!.id;
  researcherUserId = r.id;
  buyerId = (await prisma.user.create({ data: { email: 'b@dsp.io', identityVerified: true } })).id;
  strangerId = (await prisma.user.create({ data: { email: 'x@dsp.io', identityVerified: true } }))
    .id;
  operatorId = (
    await prisma.user.create({
      data: { email: 'op@dsp.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;
  // 인정(판정 뒤집기)에 2인 승인이 걸려 승인자가 따로 필요하다
  secondOperatorId = (
    await prisma.user.create({
      data: { email: 'op2@dsp.io', identityVerified: true, role: 'OPERATOR' },
    })
  ).id;

  const draft = await createDraftReport(
    prisma,
    {
      researcherId,
      title: 'KRW-DSP 전망',
      summary: '요약',
      content: '본문',
      priceKrw: 10_000,
      prepaymentRatio: 0,
      card: {
        assetClass: 'CRYPTO',
        ticker: 'KRW-DSP',
        assetName: 'KRW-DSP',
        direction: 'UP',
        targetType: 'RETURN_PCT',
        targetValue: 10,
        confidence: 5,
        selfStability: 5,
        deadline: DEADLINE,
      },
    },
    DRAFT_NOW,
  );
  await publishReport(prisma, registry('KRW-DSP'), draft.id, researcherId, PUBLISH_NOW);
  const p = await purchaseReport(prisma, draft.id, buyerId, PUBLISH_NOW);
  purchaseId = p.id;
  await judgeAndSettleDueCards(prisma, registry('KRW-DSP'), BATCH_NOW, 'CRYPTO'); // 적중 → 지급 대기
});

afterAll(async () => {
  await prisma.$disconnect();
});

// **실패 판정에서 억울한 쪽은 리서처다** (2026-08-15, 외부 검토 반영).
//
// 이 표를 구매자 전용으로 만든 근거는 투자자문업 경계였는데, 그것이 막으려던 것은
// 리서처↔구매자 소통이지 리서처가 심판에게 데이터 오류를 따지는 일이 아니다.
// 주장의 종류가 같으므로 표도 하나다 — 갈리는 것은 처분이다.
describe('리서처 이의', () => {
  it('맞다고 보는 가격 없이는 접수되지 않는다 — 이것이 남용 방지 장치다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: 'KRW-DSP' } });
    await expect(
      fileResearcherDispute(
        prisma,
        { cardId: card.id, researcherId, category: 'PRICE_DATA', claimedPrice: 0 },
        BATCH_NOW,
      ),
    ).rejects.toMatchObject({ code: 'BAD_INPUT' });
  });

  it('남의 카드에는 낼 수 없다 — 없는 것과 남의 것을 같은 말로 답한다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: 'KRW-DSP' } });
    await expect(
      fileResearcherDispute(
        prisma,
        { cardId: card.id, researcherId: 'someone-else', category: 'PRICE_DATA', claimedPrice: 95 },
        BATCH_NOW,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // **구매자를 리서처 분쟁의 인질로 두지 않는다** — 리서처 이의로 환불을 멈추면
  // 틀린 판정이 아니어도 구매자 돈이 리서처의 항의만으로 묶인다
  it('정산 흐름을 멈추지 않는다 — 구매자 이의와 갈리는 유일한 지점', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: 'KRW-DSP' } });
    const before = await settlementIdsWithOpenDispute(prisma);

    const d = await fileResearcherDispute(
      prisma,
      {
        cardId: card.id,
        researcherId,
        category: 'PRICE_DATA',
        claimedPrice: 112,
        observed: '업비트 8/1 종가',
      },
      BATCH_NOW,
    );
    expect(d.actorRole).toBe('RESEARCHER');
    expect(d.purchaseId).toBeNull(); // 판정에 붙지 구매에 붙지 않는다

    // 멈추는 정산 집합이 하나도 늘지 않는다
    expect((await settlementIdsWithOpenDispute(prisma)).size).toBe(before.size);
  });

  it('같은 판정에 두 번은 못 낸다 — 같은 주장을 다시 낸다고 답이 달라지지 않는다', async () => {
    const card = await prisma.predictionCard.findFirstOrThrow({ where: { ticker: 'KRW-DSP' } });
    await expect(
      fileResearcherDispute(
        prisma,
        { cardId: card.id, researcherId, category: 'PRICE_DATA', claimedPrice: 113 },
        BATCH_NOW,
      ),
    ).rejects.toMatchObject({ code: 'ALREADY_FILED' });
  });
});


describe('판정 이의제기', () => {
  it('산 사람만 제기할 수 있다 — 없는 것과 남의 것을 같은 말로 답한다', async () => {
    await expect(
      fileDispute(
        prisma,
        { purchaseId, buyerId: strangerId, category: 'PRICE_DATA' },
        BATCH_NOW,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  // **접수가 정산을 멈춘다.** 판정이 뒤집힐 수 있는 건에 돈이 나가면 되돌릴 수 없다 —
  // revertJudgment가 지급 실행된 건을 거부하는 것과 같은 이유다
  it('접수하면 지급이 멈춘다 — 큐에서 빠지고 실행도 거부된다', async () => {
    expect(await getPendingPayouts(prisma)).toHaveLength(1);

    await fileDispute(
      prisma,
      { purchaseId, buyerId, category: 'PRICE_DATA', observed: '8/1 종가 95원' },
      BATCH_NOW,
    );

    // 누를 수 없는 것은 보이지도 않아야 한다
    expect(await getPendingPayouts(prisma)).toHaveLength(0);

    const settlement = await prisma.settlement.findFirstOrThrow({ where: { purchaseId } });
    await expect(
      executePayout(
        prisma,
        { settlementId: settlement.id, operatorUserId: operatorId, confirmedSettled: true },
        EXEC_NOW,
      ),
    ).rejects.toThrow(/판정 이의/);
  });

  // **리서처는 무엇을 주장하는지도, 누가 냈는지도 못 본다.**
  // 넘기는 순간 이 창구가 구매자↔리서처 소통 경로가 되고, 그게 투자자문업 해석 위험의 시작이다
  it('리서처에게는 사실만 알린다 — 내용도 사람도 넘기지 않는다', async () => {
    const noti = await prisma.notification.findFirstOrThrow({
      where: { userId: researcherUserId, title: { contains: '판정 검토' } },
    });
    expect(noti.body).toContain('정산이 잠시 보류');
    expect(noti.body).not.toContain('95원'); // 제보 내용
    expect(noti.body).not.toContain('b@dsp.io'); // 제기한 사람
  });

  it('한 구매에 두 번 제기할 수 없다', async () => {
    await expect(
      fileDispute(prisma, { purchaseId, buyerId, category: 'TIMING' }, BATCH_NOW),
    ).rejects.toMatchObject({ code: 'ALREADY_FILED' });
  });

  it('운영자 큐에 판정 근거와 함께 뜬다 — 대조할 것이 한 화면에 있어야 한다', async () => {
    // 청구인이 둘이 됐으므로 어느 쪽인지 명시한다
    const d = (await getOpenDisputes(prisma)).find((x) => x.actorRole === 'PURCHASER')!;
    expect(d.category).toBe('PRICE_DATA');
    expect(d.observed).toBe('8/1 종가 95원');
    expect(d.judgment?.marketSnapshotJson).not.toBeNull(); // 판정에 쓴 원본 시세
    expect(d.judgment?.predictionCard.ticker).toBe('KRW-DSP');
  });

  // **기각도 반드시 알린다.** 접수만 되고 답이 없으면 그 사람은 카드사로 간다 —
  // 이 창구를 만든 이유가 바로 그것을 막는 것이다
  it('기각해도 구매자에게 결과를 알리고, 그 뒤 지급이 다시 열린다', async () => {
    // 청구인이 둘이 됐으므로 어느 쪽인지 명시한다 — 같은 시각에 접수되면 순서가 안 정해진다
    const d = (await getOpenDisputes(prisma)).find((x) => x.actorRole === 'PURCHASER')!;
    const r = await resolveDispute(
      prisma,
      {
        disputeId: d.id,
        operatorUserId: operatorId,
        verdict: 'REJECTED',
        resolution: '8월 1일 종가는 120원으로 확인됩니다.',
      },
      BATCH_NOW,
    );
    expect(r.needsRevert).toBe(false);

    const noti = await prisma.notification.findFirstOrThrow({
      where: { userId: buyerId, title: { contains: '판정 검토 결과' } },
    });
    expect(noti.body).toContain('120원');

    // 끝난 이의는 정산을 더 막지 않는다 — 막으면 그 돈이 영원히 갇힌다
    expect(await getPendingPayouts(prisma)).toHaveLength(1);
  });

  it('창이 닫힌 뒤에는 접수하지 않는다 — 정산이 영원히 불확실해지면 안 된다', async () => {
    const late = new Date(BATCH_NOW.getTime() + (DISPUTE_WINDOW_DAYS + 1) * 86_400_000);
    await prisma.judgmentDispute.deleteMany({});
    await expect(
      fileDispute(prisma, { purchaseId, buyerId, category: 'PRICE_DATA' }, late),
    ).rejects.toBeInstanceOf(DisputeError);
  });

  // 이 창구가 생기기 전에는 "우리가 되돌린 판정"만 셀 수 있었다 —
  // 구매자의 불만이 데이터가 되지 못했다
  it('지표 ③이 이제 진짜 이의제기율을 센다', async () => {
    await fileDispute(prisma, { purchaseId, buyerId, category: 'CORPORATE_ACTION' }, BATCH_NOW);
    const m = (await getOpsMetrics(prisma, BATCH_NOW)).find((x) => x.key === 'disputeRate')!;
    expect(m.sample).toContain('이의 1건');
    expect(m.value).toBe('100.0%'); // 판정 1건 중 1건 — 분모가 함께 실려야 오도가 아니다
    expect(m.sample).toContain('전체 판정 1건');
  });

  // **인정은 판정을 뒤집는 결정이라 2인 승인이 걸린다** (2026-08-16 검토 3차).
  // 판정은 돈이 흐를 방향을 정하는 원천이다 — 내부자와 공모한 구매자가 적중을
  // 실패로 뒤집어 환불을 뽑는 경로의 첫 관문이 여기다. 기각은 데이터의 판정을
  // 유지하는 쪽이라 한 사람으로 족하다 (위의 기각 시험이 승인 없이 통과하는 것이 증거)
  it('인정의 첫 확정은 승인 요청으로 멈추고, 요청자는 자기 요청을 승인할 수 없다', async () => {
    const [open] = await getOpenDisputes(prisma);
    await expect(
      resolveDispute(
        prisma,
        {
          disputeId: open.id,
          operatorUserId: operatorId,
          verdict: 'UPHELD',
          resolution: '공급자가 8/1 종가를 잘못 줬습니다',
        },
        BATCH_NOW,
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_PENDING' });

    // 확정이 멈췄으니 구매자에게 "오류 확인" 통지도 아직 없어야 한다 —
    // 통지가 먼저 나가면 승인이 반려됐을 때 말을 주워 담을 수 없다
    const early = await prisma.notification.findFirst({
      where: { userId: buyerId, title: { contains: '오류가 확인' } },
    });
    expect(early).toBeNull();

    // 요청은 자동으로 올라가 있고, 판단 근거가 그대로 승인자의 사유가 된다
    const req = await prisma.operatorApproval.findFirstOrThrow({
      where: { action: 'DISPUTE_UPHOLD', targetId: open.id, status: 'PENDING' },
    });
    expect(req.reason).toContain('8/1 종가');

    // 같은 운영자는 승인 못 한다 — 이 한 줄이 2인 승인의 전부다
    await expect(
      decideApproval(
        prisma,
        { approvalId: req.id, approverUserId: operatorId, approve: true },
        BATCH_NOW,
      ),
    ).rejects.toThrow(/요청한 사람은 승인할 수 없습니다/);
  });

  // **인정은 판단이고 되돌리기는 돈이다** — 일부러 한 버튼에 묶지 않았다.
  // 그러면 사람이 이어서 해야 하는데, 목록이 없으면 "오류가 확인되었습니다"라고
  // 알린 뒤 아무 일도 안 일어난 건이 조용히 쌓인다. 그게 가장 나쁜 침묵이다
  it('인정한 이의는 되돌릴 때까지 운영자 화면에 남는다', async () => {
    const [open] = await getOpenDisputes(prisma);
    // 앞 시험이 올린 승인 요청을 다른 운영자가 승인한다 → 이번 확정이 소비한다
    const req = await prisma.operatorApproval.findFirstOrThrow({
      where: { action: 'DISPUTE_UPHOLD', targetId: open.id, status: 'PENDING' },
    });
    await decideApproval(
      prisma,
      { approvalId: req.id, approverUserId: secondOperatorId, approve: true },
      BATCH_NOW,
    );
    await resolveDispute(
      prisma,
      {
        disputeId: open.id,
        operatorUserId: operatorId,
        verdict: 'UPHELD',
        resolution: '공급자가 8/1 종가를 잘못 줬습니다',
      },
      BATCH_NOW,
    );
    // 승인서는 1회용 — 확정이 써서 없앴다
    expect(
      await prisma.operatorApproval.findFirst({
        where: { action: 'DISPUTE_UPHOLD', targetId: open.id, status: 'EXECUTED' },
      }),
    ).not.toBeNull();

    const pending = await getUpheldPendingRevert(prisma);
    expect(pending).toHaveLength(1);
    expect(pending[0].judgment?.predictionCard.ticker).toBe('KRW-DSP');

    // 되돌리면 판정 행이 사라지며 링크가 끊겨 **목록이 스스로 비워진다** —
    // 따로 완료 표시를 만들면 그것을 누르지 않은 건이 또 쌓인다
    await revertJudgment(
      prisma,
      {
        judgmentId: pending[0].judgment!.id,
        operatorUserId: operatorId,
        reason: '이의 인정 — 종가 오류',
        cause: 'DATA_SOURCE',
      },
      BATCH_NOW,
    );
    expect(await getUpheldPendingRevert(prisma)).toHaveLength(0);

    // 판정은 없던 일이 돼도 **이의 기록은 남는다** (지표 ③의 분자이자 분쟁 시 우리 기록)
    const kept = await prisma.judgmentDispute.findUniqueOrThrow({ where: { id: open.id } });
    expect(kept.status).toBe('UPHELD');
    expect(kept.judgmentId).toBeNull();
  });
});
