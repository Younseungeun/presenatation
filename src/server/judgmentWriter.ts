import type { Prisma, PrismaClient, PredictionCard, Purchase, Report } from '@prisma/client';
import { causeFromDataSource } from '@/domain/compensation';
import type { JudgmentResult } from '@/domain/judgment';
import { settle } from '@/domain/settlement';
import { auditOp } from './auditLog';
import { buildCompensationWrites } from './compensationService';

// 판정 결과 영속화 + 에스크로 3분기 정산 + 인앱 알림 쓰기 묶음.
// 자동 배치(judgmentBatch)와 운영자 수동 판정(manualJudgmentService)이 공유한다 —
// 어느 경로로 판정하든 점수·정산·감사 기록·알림의 형태는 동일해야 한다.
//
// ── **쓰기 개수가 구매 건수에 비례하지 않는다** (2026-08-16) ──────
// 예전에는 구매 1건마다 정산·구매 상태·알림을 따로 썼고, 보상 지시서가 붙으면서
// 구매당 4문장이 됐다. 구매 500건이면 **한 트랜잭션에 2,000문장**이고 그동안
// SQLite 쓰기 락이 잡혀 있다 — 그 순간 결제가 죽는다.
//
// `measureWriteContention`이 실측한 것은 "트랜잭션 안에서 I/O를 하면 죽는다"가
// 아니라 **"트랜잭션이 길면 죽는다"**였다. I/O는 길어지는 흔한 원인일 뿐이고,
// 여기는 문장 수만으로 같은 곳에 도달한다. `noIoInTransaction` 불변식은 이쪽을
// 보지 않으므로 아무도 막아 주지 않았다.
//
// ── 알림을 밖으로 빼는 대신 묶는다 ───────────────────────────────
// 외부 검토는 알림을 트랜잭션 밖으로 빼라고 했다(락 시간 1/3). 방향은 맞지만
// **더 나은 수가 있다**: `createMany`로 묶으면 N문장이 **1문장**이 되면서
// 원자성도 그대로다. 알림은 환불 인지의 주 경로라(CLAUDE.md §7) 커밋 뒤로 빼면
// 프로세스가 죽는 순간 "돈은 환불되는데 아무도 모르는" 건이 생긴다 —
// 원자성을 파는 대가로 얻을 것이 없는데 팔 이유가 없다.
//
// 같은 방법을 정산·보상에도 쓰고(createMany), 구매 상태는 값이 두 가지뿐이라
// **상태별 updateMany 두 문장**으로 접는다. 결과: **총 7문장 이하, N과 무관.**

export type CardWithHeldPurchases = PredictionCard & {
  report: Report & { purchases: Purchase[]; researcher: { userId: string } };
};

const OUTCOME_LABEL: Record<string, string> = {
  HIT: '적중',
  MISS: '실패',
  UNDECIDABLE: '판정 불가',
};

export interface JudgmentRecordInput {
  result: JudgmentResult;
  realizedReturnPct: number | null;
  score: number;
  /** 가중 전 정보량 — 규율 래더의 입력. scoreJudgedCard가 점수와 함께 낸다 */
  info: number;
  dataSource: string;
  /** 감사·분쟁 재현용 스냅샷 (JSON 직렬화 가능한 객체) */
  audit: unknown;
  /** 소급 확정된 기준가 — 있으면 카드에도 기록 */
  resolvedBasePrice?: number | null;
}

/**
 * 판정 1건의 전체 쓰기(판정 레코드 + 기준가 소급 + 정산/에스크로 갱신)를 반환한다.
 * 호출자가 $transaction으로 묶어 원자적으로 실행한다.
 * 멱등성은 Judgment.predictionCardId unique가 보장 — 중복 실행 시 트랜잭션 전체가 실패한다.
 */
export function buildJudgmentWrites(
  prisma: PrismaClient,
  card: CardWithHeldPurchases,
  input: JudgmentRecordInput,
  now: Date,
): Prisma.PrismaPromise<unknown>[] {
  const { result } = input;
  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.judgment.create({
      data: {
        predictionCardId: card.id,
        outcome: result.outcome,
        undecidableReason: result.undecidableReason ?? null,
        settledPrice: result.settledPrice ?? null,
        realizedReturnPct: input.realizedReturnPct,
        score: input.score,
        info: input.info,
        dataSource: input.dataSource,
        marketSnapshotJson: JSON.stringify(input.audit),
        judgedAt: now,
      },
    }),
  ];

  // 소급 확정된 기준가를 카드에 기록 (감사 추적)
  if (input.resolvedBasePrice != null) {
    writes.push(
      prisma.predictionCard.update({
        where: { id: card.id },
        data: { basePrice: input.resolvedBasePrice },
      }),
    );
  }

  // 에스크로 3분기 정산 — 금액 보존 불변식은 settle()이 보장.
  // 환불은 항상 현금(확정) — Settlement 기록이 PG 취소/계좌이체 지시서 역할.
  // 전액 환불 건만 REFUNDED로 구분.
  const label = OUTCOME_LABEL[result.outcome] ?? result.outcome;
  let payoutTotal = 0;
  let refundTotal = 0;

  const settlements: Prisma.SettlementCreateManyInput[] = [];
  const notifications: Prisma.NotificationCreateManyInput[] = [];
  /** 구매 상태는 값이 둘뿐이라 id 목록만 모아 두면 updateMany 두 문장으로 끝난다 */
  const refunded: string[] = [];
  const settled: string[] = [];

  for (const p of card.report.purchases) {
    const s = settle({
      amountKrw: p.amountKrw,
      feeRateBp: card.report.feeRateBp!,
      prepaymentRatio: card.report.prepaymentRatio,
      outcome: result.outcome,
    });
    payoutTotal += s.researcherPayoutKrw;
    refundTotal += s.buyerRefundKrw;
    settlements.push({
      purchaseId: p.id,
      outcome: s.outcome,
      researcherPayoutKrw: s.researcherPayoutKrw,
      platformFeeKrw: s.platformFeeKrw,
      buyerRefundKrw: s.buyerRefundKrw,
      refundType: s.refundType,
      settledAt: now,
    });
    (s.buyerRefundKrw === p.amountKrw ? refunded : settled).push(p.id);
    // 구매자 알림: 판정 결과와 환불 여부를 즉시 통지 (환불 인지가 서비스 신뢰의 핵심)
    notifications.push({
      userId: p.buyerId,
      type: 'JUDGMENT_RESULT',
      title: `구매 리포트 판정: ${card.assetName} ${label}`,
      body:
        result.outcome === 'HIT'
          ? '예측이 적중했습니다. 결제액은 리서처에게 정산됩니다.'
          : result.outcome === 'MISS'
            ? `예측이 빗나갔습니다. ${s.buyerRefundKrw.toLocaleString()}원이 현금 환불됩니다.`
            : `판정 불가 처리되었습니다. 전액(${s.buyerRefundKrw.toLocaleString()}원)이 환불됩니다.`,
      link: `/report/${card.reportId}`,
      createdAt: now,
    });
  }

  // **정산은 한 문장이다.** `createMany`는 중복을 그냥 넘기지 않으므로(skipDuplicates
  // 기본 false) Settlement.purchaseId unique가 여전히 재실행을 막는다 — 멱등성은
  // 판정 레코드와 정산 양쪽에서 그대로 유지된다
  if (settlements.length > 0) {
    writes.push(prisma.settlement.createMany({ data: settlements }));
  }
  // ⚠ `update`에서 `updateMany`로 바꾸면 **없는 행에 대한 예외가 사라진다.** 여기서는
  // 구매 목록을 카드에서 함께 읽어 온 것이라 없을 수 없고, 대신 얻는 것이 크다
  for (const [ids, escrowStatus] of [
    [refunded, 'REFUNDED'],
    [settled, 'SETTLED'],
  ] as const) {
    if (ids.length > 0) {
      writes.push(prisma.purchase.updateMany({ where: { id: { in: ids } }, data: { escrowStatus } }));
    }
  }

  // 리서처 알림: 판정 결과 + 점수 + 정산 요약
  const settleSummary =
    card.report.purchases.length === 0
      ? '판매된 구매 건이 없습니다.'
      : payoutTotal > 0
        ? `${payoutTotal.toLocaleString()}원이 정산됩니다 (구매 ${card.report.purchases.length}건).`
        : `구매 ${card.report.purchases.length}건, ${refundTotal.toLocaleString()}원이 구매자에게 환불됩니다.`;

  // **얼마나 갔었는지를 말해 준다** (2026-08-15, 외부 검토의 이탈 시나리오).
  //
  // 전에는 실패 알림이 "점수 −N점, 0원 정산"뿐이었다. +9.8%로 끝난 사람과 −30%로
  // 끝난 사람이 **똑같은 문장**을 받는다. 시스템은 종가 극값을 이미 알고 있으면서
  // 안 알려 준 것이고, 그 침묵이 "여기는 내 분석을 보지 않는다"로 읽힌다.
  //
  // ⚠ **처분은 하나도 바꾸지 않는다.** 환불도 점수도 적중률도 그대로다 —
  // 근접을 봐주기 시작하면 "목표의 몇 %까지는 맞은 셈"이라는 새 경계가 생기고,
  // 경계가 생기면 그 경계를 노리는 신고가 생긴다(수익성 가중 계단에서 이미 겪었다).
  // 바뀌는 것은 **같은 처분을 설명하는 방식**뿐이다.
  const peak = result.outcome === 'MISS' ? result.peakProgress : undefined;
  const peakNote =
    peak !== undefined && peak > 0
      ? ` 목표까지 ${Math.min(99, Math.round(peak * 100))}% 지점(종가 기준)이 최고였습니다.`
      : '';
  notifications.push({
    userId: card.report.researcher.userId,
    type: 'JUDGMENT_RESULT',
    title: `예측 판정: ${card.assetName} ${label}`,
    body: `점수 ${input.score > 0 ? '+' : ''}${Math.round(input.score)}점. ${settleSummary}${peakNote}`,
    link: `/researcher/${card.report.researcherId}`,
    createdAt: now,
  });
  // 구매자 N명 + 리서처 1명이 **한 문장**으로 나간다. 알림을 커밋 뒤로 빼지 않는
  // 이유는 위 머리글에 적었다 — 이것이 환불 인지의 주 경로다
  writes.push(prisma.notification.createMany({ data: notifications }));

  // **사람이 매긴 판정만 감사 로그에 남긴다** (2026-08-15, 외부 검토 반영).
  //
  // 처음에는 자동 판정도 남겼다 — "에스크로가 갈라지는 순간이니 돈의 근거가 바뀐
  // 사건"이라는 근거였는데, 그 기준으로는 **정상 하루치가 통째로 들어온다.** 감사
  // 로그는 평화로울 때 침묵해야 개입이 눈에 띈다.
  //
  // 자르는 선을 *행위*가 아니라 **행위자**에 둔 것이 요점이다. 검토는 "판정 생성을
  // 빼라"고 했지만 그대로 하면 **수동 판정까지 함께 사라진다** — 운영자가 시세를
  // 직접 입력해 적중을 만드는 일은 도메인 흐름이 아니라 개입이고, 탈취된 세션이
  // 돈에 닿는 가장 짧은 경로이기도 하다. 같은 Judgment 행을 만들어도 배치가 하면
  // 기록이고 사람이 하면 사건이다.
  //
  // 빠진 자동 판정의 타임라인 첫 줄은 `getAuditTrail`이 **조회 시점에** Judgment
  // 행에서 합쳐 준다 — 쓰기를 나누면 어긋날 수 있지만 읽기를 합치는 것은 어긋날
  // 자리가 없다.
  //
  // 정산이 몇 건이 되든 로그는 **판정 하나에 한 줄**이다. "정산 s_1이 왜 생겼나"는
  // 도메인 외래키를 타고 올라와(Settlement → Purchase → Report → PredictionCard →
  // Judgment) targetId로 조회한다 — 하위 id를 JSON에 담아 검색하게 만들면 SQLite에는
  // JSON 인덱스가 없어 풀스캔이 된다.
  // ── **우리 사정으로 못 쟀으면 보상 지시서도 같은 트랜잭션에서 태어난다** (2026-08-16) ──
  //
  // 여기에 두는 이유는 **하드캡 경로가 셋이기 때문**이다(정지 중 / 수동 큐 / 시세 미확보·
  // 오류). 호출자마다 보상 생성을 붙이면 언젠가 한 곳이 빠지고, 빠진 자리는 **닫힌 카드가
  // 정상 판정과 똑같이 보여** 아무도 못 찾는다. 판정을 쓰는 유일한 통로가 여기이므로
  // 여기서 한 번 갈라 놓으면 새 경로가 생겨도 저절로 따라온다.
  //
  // 갈라내는 기준은 `dataSource` 하나다 — 결과(UNDECIDABLE)로 가르면 상장폐지·강제
  // 철회처럼 **우리 탓이 아닌 판정 불가**까지 보상 대상이 된다.
  const cause = causeFromDataSource(input.dataSource);
  if (cause) {
    writes.push(...buildCompensationWrites(prisma, card, cause, now));
  }

  const operator = input.dataSource.startsWith('manual:')
    ? input.dataSource.slice('manual:'.length)
    : null;
  if (operator) {
    writes.push(
      auditOp(prisma, {
        actor: operator,
        actorType: 'OPERATOR',
        action: 'MANUAL_JUDGMENT',
        targetType: 'PredictionCard',
        targetId: card.id,
        after: {
          outcome: result.outcome,
          settledPrice: result.settledPrice ?? null,
          score: Math.round(input.score),
          payoutKrw: payoutTotal,
          refundKrw: refundTotal,
          purchases: card.report.purchases.length,
        },
        at: now,
      }),
    );
  }

  return writes;
}
