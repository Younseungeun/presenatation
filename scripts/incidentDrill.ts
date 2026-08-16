import { PrismaClient } from '@prisma/client';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { FixtureMarketDataProvider } from '../src/infra/marketData/fixtureProvider';
import type { ProviderRegistry } from '../src/domain/marketData';
import {
  clearManualOnlyForRange,
  pauseAndBulkRevert,
  planBulkRevert,
} from '../src/server/bulkRevertService';
import { hashCi } from '../src/server/authService';
import { getPauseState, setJudgmentPause } from '../src/server/judgmentPause';
import {
  fileDispute,
  fileResearcherDispute,
  getOpenDisputes,
  resolveDispute,
} from '../src/server/judgmentDisputeService';
import { judgeAndSettleDueCards } from '../src/server/judgmentBatch';
import { flushOpsAlerts } from '../src/server/opsAlertFeed';
import { purchaseReport } from '../src/server/purchaseService';
import { createDraftReport, publishReport } from '../src/server/reportService';
import {
  ACCOUNT_CHANGE_COOLDOWN_MS,
  applyHolderLookup,
  registerPayoutAccount,
} from '../src/server/payoutAccountService';
import { getCooldownHold, SETTLEMENT_COOLDOWN_HOURS } from '../src/server/settlementCooldown';
import {
  executePayout,
  getPendingPayouts,
  getPendingRefunds,
} from '../src/server/settlementOpsService';

// **사고 대응 리허설** — `npm run drill` (2026-08-15, 외부 검토의 요청).
//
// 25회차 동안 방어선을 하나씩 쌓았는데, 각각은 시험이 있어도 **함께 돌아가는 것**은
// 아무도 확인하지 않았다. 검토의 표현대로 "운영자가 펜싱 토큰과 함께 숨을 쉴 수
// 있는지"는 단위 시험이 답하지 못한다.
//
// ── CI에 넣지 않는다 (2026-08-15 확정) ──────────────────────────────
// 이 스크립트에는 단언(assertion)이 없다. 출력을 **사람이 읽는 것**이 목적이기 때문이다.
// 그 상태로 자동 실행에 넣으면 두 갈래로 다 나빠진다:
//  · 단언 없이 넣으면 → 아무도 안 읽는 로그가 된다. 초록불이 뜨는데 아무것도 검증하지 않는다
//  · 최소 단언을 붙이면 → 그 순간 평범한 E2E 시험으로 전락한다. 리허설의 값어치는
//    "예상하지 못한 부수 효과가 눈에 띄는 것"인데, 단언을 통과하도록 다듬는 순간
//    예상한 것만 보게 된다
// **찾아낸 결함은 시험으로 승격한다** — 그래야 회귀가 자동으로 잡힌다:
//  · 이의 제기가 환불 실행을 막는다 → server/__tests__/judgmentDispute.db.test.ts
//  · 되돌린 카드를 자동 판정으로 되돌리는 길 → server/__tests__/bulkRevert.db.test.ts
// 리허설 자체는 **배포 전 사람이 눈으로 읽고 승인하는 체크리스트 단계**로 남는다.
//
// 이 스크립트는 **일회용 DB**에 사고를 하나 만들고 운영자가 실제로 밟는 순서를 그대로
// 밟는다. 통과/실패를 채점하지 않고 **각 단계에서 운영자가 무엇을 보는지**를 찍는다 —
// 찾는 것은 버그가 아니라 **막히는 자리**다.
//
//   ① 공급자가 틀린 종가를 준다 → 배치가 9장을 오판정
//   ② 고위험 알림이 나간다 (운영자가 아는 유일한 경로)
//   ③ 구매자가 이의를 낸다 → 그 건의 지급이 큐에서 사라진다
//   ④ 리서처도 이의를 낸다 → 이쪽은 정산을 멈추지 않는다
//   ⑤ 운영자가 드라이런으로 범위를 확인한다
//   ⑥ 멈추고 되돌린다 (한 명령)
//   ⑦ 이의를 확정한다
//   ⑧ 시세를 고치고 다시 판정 → 쿨다운 → 지급
//
// **일회용 DB를 쓴다** — 개발 DB에 사고를 만들면 그 상태가 남는다.

/** 리허설 리서처의 본인 인증 결과 — 계좌 등록마다 다시 받는 값 */
const DRILL_IDENTITY = { ci: 'ci-drill-researcher', name: '드릴본인' };

const DB = 'prisma/drill.db';
const DRAFT = new Date('2026-07-01T00:00:00Z');
const PUBLISH = new Date('2026-07-02T00:00:00Z');
const DEADLINE = new Date('2026-08-01T00:00:00Z');
const JUDGE_AT = new Date('2026-08-02T00:00:00Z');
const AFTER_COOLDOWN = new Date(
  JUDGE_AT.getTime() + (SETTLEMENT_COOLDOWN_HOURS + 1) * 3_600_000,
);

let step = 0;
function head(title: string) {
  step += 1;
  console.log(`\n${'─'.repeat(72)}\n[${step}] ${title}\n${'─'.repeat(72)}`);
}
function note(s: string) {
  console.log(`   ${s}`);
}

/** 기준가 100 → 목표 +30% (130). 종가 인자로 정상/오류 세계를 만든다 */
function registry(ticker: string, closeAtDeadline: number): ProviderRegistry {
  const p = new FixtureMarketDataProvider().setCurrentPrice(ticker, 100);
  p.setQuotes(ticker, [
    { date: '2026-07-02', open: 100, high: 100, low: 100, close: 100, volume: 1 },
    {
      date: '2026-08-01',
      open: closeAtDeadline,
      high: Math.max(closeAtDeadline, 100),
      low: Math.min(closeAtDeadline, 100),
      close: closeAtDeadline,
      volume: 1,
    },
  ]);
  return { CRYPTO: p };
}

async function main() {
  // 결제 관문의 실시간 시세 조회를 끈다 — 이 리허설이 시험하는 것은 가격 방어선이
  // 아니라 **사고 대응 절차**이고, 여기서 진짜 공급자를 부르면 네트워크가 리허설의
  // 성패를 가른다 (server/priceCache의 VITEST 분기와 같은 의도다)
  process.env.VITEST = '1';

  // ── 준비: 일회용 DB ────────────────────────────────────────
  for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }
  if (!existsSync('prisma')) mkdirSync('prisma');
  process.env.DATABASE_URL = `file:${DB.replace('prisma/', '')}`;
  execSync('npx prisma migrate deploy', { stdio: 'pipe' });

  const prisma = new PrismaClient({ datasources: { db: { url: `file:./${DB.replace('prisma/', '')}` } } });

  const researcher = await prisma.user.create({
    data: {
      email: 'r@drill.io',
      penName: '드릴리서처',
      identityVerified: true,
      // 계좌 등록이 본인 인증 재확인을 요구하므로, 리허설도 실제와 같은 사람이어야 한다
      identityHash: hashCi(DRILL_IDENTITY.ci),
      researcherProfile: { create: { tier: 'CHALLENGER' } },
    },
    include: { researcherProfile: true },
  });
  const researcherId = researcher.researcherProfile!.id;
  const buyer = await prisma.user.create({
    data: { email: 'b@drill.io', penName: '드릴구매자', identityVerified: true },
  });
  const operator = await prisma.user.create({
    data: { email: 'op@drill.io', identityVerified: true, role: 'OPERATOR' },
  });
  await prisma.instrument.create({
    data: {
      assetClass: 'CRYPTO',
      ticker: 'KRW-DRL',
      name: '드릴코인',
      shortable: true,
      active: true,
      source: 'drill',
      // **σ를 심어 둔다.** 안 심으면 게시 관문이 "표본이 모자란 종목"으로 보고 막는다
      // (reportService.INSUFFICIENT_MARKET_DATA) — 리허설이 시험하는 것은 사고 대응이지
      // 신규 상장 방어가 아니라, 여기서 막히면 뒤의 10단계를 하나도 못 돈다.
      // 조용한 종목으로 두는 이유도 같다: 카드가 크기 하한에 걸리면 안 된다
      sigmaDaily: 0.02,
      sigmaSyncedAt: new Date('2026-01-01T00:00:00Z'),
    },
  });

  const cardIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const draft = await createDraftReport(
      prisma,
      {
        researcherId,
        title: `드릴 리포트 ${i + 1}`,
        summary: '요약',
        content: '본문',
        priceKrw: 20_000,
        prepaymentRatio: 0,
        card: {
          assetClass: 'CRYPTO',
          ticker: 'KRW-DRL',
          assetName: '드릴코인',
          direction: 'UP',
          targetType: 'RETURN_PCT',
          // 리허설 종목은 σ를 잰 적이 없어 **거친 쪽 폴백**이 쓰인다(UNMEASURED_SIGMA).
          // 그래서 하한이 31.7%까지 올라간다 — 넉넉히 넘겨 둔다
          targetValue: 40,
          confidence: 5,
          selfStability: 5,
          deadline: DEADLINE,
        },
      },
      DRAFT,
    );
    await publishReport(prisma, registry('KRW-DRL', 100), draft.id, researcherId, PUBLISH);
    await purchaseReport(prisma, draft.id, buyer.id, PUBLISH);
    const c = await prisma.predictionCard.findFirstOrThrow({ where: { reportId: draft.id } });
    cardIds.push(c.id);
  }

  // ── ① 공급자가 틀린 값을 준다 ─────────────────────────────
  head('공급자가 틀린 종가를 준다 — 배치가 그대로 판정한다');
  note('실제 8/1 종가는 135 (목표 130 도달 = 적중)인데 공급자가 95를 줬다.');
  const bad = await judgeAndSettleDueCards(prisma, registry('KRW-DRL', 95), JUDGE_AT, 'CRYPTO');
  note(`판정 ${bad.judged}건 — 전부 MISS로 확정됐고 구매자 환불 지시서가 만들어졌다.`);
  note('⚠ 이 시점에 시스템은 아무 이상도 감지하지 못한다 — 95는 "불가능한 값"이 아니다.');

  // ── ② 운영자가 아는 경로 ──────────────────────────────────
  head('운영자는 어떻게 아는가');
  await flushOpsAlerts(prisma, JUDGE_AT); // 커서 세우기
  const alerts = await prisma.notification.count({ where: { type: 'OPS_ALERT' } });
  note(`고위험 알림: ${alerts}건`);
  note('자동 판정은 감사 로그에 안 남으므로 여기서 알림은 0이다. 정상이다 —');
  note('평화로울 때 침묵하는 것이 이 로그의 규칙이고, **오판정은 사람이 신고해서 알려진다.**');
  note('→ 첫 신호는 알림이 아니라 이의 접수다. 그래서 이의 창구가 사고 탐지기다.');

  // ── ③ 구매자 이의 ─────────────────────────────────────────
  head('구매자가 이의를 낸다 — 그 건의 지급이 큐에서 사라진다');
  const purchases = await prisma.purchase.findMany({ where: { buyerId: buyer.id } });
  await fileDispute(
    prisma,
    {
      purchaseId: purchases[0].id,
      buyerId: buyer.id,
      category: 'PRICE_DATA',
      observed: '8/1 종가 135 (업비트)',
    },
    JUDGE_AT,
  );
  note(`구매자 이의 접수 — 미실행 환불 큐 ${(await getPendingRefunds(prisma, AFTER_COOLDOWN)).length}건`);

  // ── ④ 리서처 이의 ─────────────────────────────────────────
  head('리서처도 이의를 낸다 — 이쪽은 정산을 멈추지 않는다');
  await fileResearcherDispute(
    prisma,
    {
      cardId: cardIds[1],
      researcherId,
      category: 'PRICE_DATA',
      claimedPrice: 135,
      observed: '업비트 8/1 일봉 종가',
    },
    JUDGE_AT,
  );
  const open = await getOpenDisputes(prisma);
  note(`열린 이의 ${open.length}건 — ${open.map((d) => d.actorRole).join(', ')}`);
  note('리서처 이의는 환불을 막지 않는다: 구매자를 리서처 분쟁의 인질로 두지 않는다.');
  note(`미실행 환불 큐: ${(await getPendingRefunds(prisma, AFTER_COOLDOWN)).length}건 (리서처 이의 건은 그대로 나간다)`);

  // ── ⑤ 드라이런 ────────────────────────────────────────────
  head('운영자가 범위를 확인한다 — 드라이런');
  const filter = {
    judgedFrom: new Date('2026-08-02T00:00:00Z'),
    judgedTo: new Date('2026-08-02T23:59:59Z'),
    assetClass: 'CRYPTO' as const,
  };
  const plan = await planBulkRevert(prisma, filter);
  note(`대상 ${plan.items.length}건 · 되돌릴 수 있음 ${plan.revertable} · 막힘 ${plan.blocked}`);
  note(`자동 판정 정지 상태: ${plan.paused ? '정지됨' : '돌고 있음'}`);

  // ── ⑥ 멈추고 되돌린다 ─────────────────────────────────────
  head('멈추고 되돌린다 — 한 명령');
  const rev = await pauseAndBulkRevert(
    prisma,
    filter,
    { operatorUserId: operator.id, reason: '공급자 8/1 종가 오류', cause: 'DATA_SOURCE' },
    JUDGE_AT,
  );
  note(`정지를 여기서 걸었나: ${rev.pausedHere} (범위 ${rev.pauseScope})`);
  note(`되돌림 ${rev.reverted.length}건 · 회계 이관 ${rev.needsAccounting.length}건 · 실패 ${rev.failed.length}건`);
  note(`정지 상태: ${JSON.stringify(await getPauseState(prisma))}`);

  const stillOpen = await getOpenDisputes(prisma);
  note(`판정이 지워졌지만 이의 기록은 남는다: ${stillOpen.length}건 (judgmentId → ${stillOpen.map((d) => d.judgmentId ?? 'null').join(', ')})`);

  // ── ⑦ 이의 확정 ───────────────────────────────────────────
  head('이의를 확정한다 — 양쪽 다 답을 받는다');
  for (const d of stillOpen) {
    await resolveDispute(
      prisma,
      {
        disputeId: d.id,
        operatorUserId: operator.id,
        verdict: 'UPHELD',
        resolution: '공급자 종가 오류 확인 — 판정을 되돌리고 재판정합니다.',
      },
      JUDGE_AT,
    );
  }
  const notis = await prisma.notification.findMany({
    where: { title: { contains: '판정 검토 결과' } },
    select: { userId: true },
  });
  const who = notis.map((n) =>
    n.userId === buyer.id ? '구매자' : n.userId === researcher.id ? '리서처' : '기타',
  );
  note(`확정 통지 ${notis.length}건 → ${who.join(', ')}`);

  // ── ⑧ 고치고 다시 판정 → 쿨다운 → 지급 ────────────────────
  head('시세를 고치고 다시 판정한다');
  await setJudgmentPause(prisma, {
    scope: 'CRYPTO',
    paused: false,
    operatorUserId: operator.id,
    reason: '공급자 정정 확인 — 8/1 종가 135로 재조회됨',
  });
  const manualOnly = await prisma.predictionCard.count({ where: { manualJudgmentOnly: true } });
  note(`사람만 판정할 카드: ${manualOnly}건 (--data-source 였으므로 자동 배치가 손대지 않는다)`);
  const blocked = await judgeAndSettleDueCards(prisma, registry('KRW-DRL', 150), JUDGE_AT, 'CRYPTO');
  note(`이 상태로 배치를 돌리면: ${blocked.judged}건 — 자물쇠가 걸려 한 장도 안 잡힌다.`);
  note('⚠ 리허설이 찾은 병목이 여기였다 — 100장을 되돌리면 100장을 손으로 판정해야 했다.');

  const reopened = await clearManualOnlyForRange(
    prisma,
    { revertedFrom: new Date('2026-08-02T00:00:00Z'), revertedTo: new Date('2026-08-02T23:59:59Z') },
    { operatorUserId: operator.id, reason: '업비트 8/1 일봉 재조회 — 135로 정정 확인' },
    JUDGE_AT,
  );
  note(`자동 판정으로 되돌린 카드: ${reopened.cleared}건 (npm run judgment:rejudge)`);
  const redo = await judgeAndSettleDueCards(prisma, registry('KRW-DRL', 150), JUDGE_AT, 'CRYPTO');
  note(`재판정: ${redo.judged}건 — 이번엔 적중이다.`);

  head('쿨다운과 지급');
  const hold = await getCooldownHold(prisma, JUDGE_AT);
  note(`쿨다운에 묶인 지시서: ${hold.count}건 · ${hold.amountKrw.toLocaleString()}원`);
  note(`가장 빨리 풀리는 시각: ${hold.nextExecutableAt?.toISOString() ?? '—'}`);
  const payouts = await getPendingPayouts(prisma, AFTER_COOLDOWN);
  note(`${SETTLEMENT_COOLDOWN_HOURS}시간 뒤 지급 큐: ${payouts.length}건`);

  // ── 계좌 관문 (2026-08-16) ──────────────────────────────────────
  // **리허설에 이 단계가 없으면 실제 운영과 어긋난다.** 지급은 이제 "검증된 계좌"를
  // 요구하고, 그것이 없으면 큐에 건이 있어도 한 푼도 안 나간다.
  // 이 단계를 넣으면서 리허설이 한 번 깨졌는데, 그게 곧 관문이 빠짐없이 걸렸다는 증거다.
  await executePayout(
    prisma,
    { settlementId: payouts[0].id, operatorUserId: operator.id, confirmedSettled: true },
    AFTER_COOLDOWN,
  ).then(
    () => note('⚠ 계좌 없이 지급이 나갔다 — 관문이 뚫렸다'),
    (e) => note(`계좌 미등록 상태의 지급 시도: 거부됨 (${(e as Error).message.slice(0, 40)}…)`),
  );
  await registerPayoutAccount(
    prisma,
    {
      researcherUserId: researcher.id,
      bankCode: '004',
      accountNumber: '110-234-567890',
      actor: researcher.id,
      // 계좌 등록은 **본인 인증을 다시 받는다** — 계정만 뚫어서는 계좌를 못 바꾼다.
      // 리허설의 리서처는 seedDrill에서 이 CI로 인증된 사람이다
      identity: DRILL_IDENTITY,
    },
    // 변경 쿨다운(48시간)을 지나 있어야 지급된다 — 탈취자가 바꾸고 곧바로 빼 가는 경로 방어
    new Date(AFTER_COOLDOWN.getTime() - ACCOUNT_CHANGE_COOLDOWN_MS - 3_600_000),
  );
  await applyHolderLookup(
    prisma,
    // 은행이 돌려준 예금주명이 **본인 인증 실명과 같아야** 검증된다 —
    // 다르면 HOLDER_MISMATCH로 떨어지고 지급이 막힌다(그 경로도 시험이 지킨다)
    { researcherUserId: researcher.id, holderName: DRILL_IDENTITY.name, actor: 'system:bank' },
    AFTER_COOLDOWN,
  );
  note('계좌 등록 + 은행 예금주 조회 → 검증 완료. 이제 지급할 수 있다.');

  if (payouts.length > 0) {
    await executePayout(
      prisma,
      { settlementId: payouts[0].id, operatorUserId: operator.id, confirmedSettled: true },
      AFTER_COOLDOWN,
    );
    note('지급 1건 실행 — 여기서 처음으로 돈이 실제로 나간다.');
  }

  console.log(`\n${'═'.repeat(72)}`);
  console.log('리허설 끝. 사고 발생 → 첫 지급까지 운영자가 친 명령: 6개');
  console.log('  드라이런 → 되돌리기(정지 포함) → 이의 확정 ×N → 정지 해제 → 재판정 열기 → 지급 실행');
  console.log('═'.repeat(72));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
