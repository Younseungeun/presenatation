# INTOVILL 37차 검토 요청 — 보상 원장을 세웠습니다

성과 검증형 리서치 마켓플레이스입니다. 리서처가 예측 카드(종목·방향·크기·시한·신뢰도)를
걸고 리포트를 팔면, 시한에 시장 데이터가 자동으로 판정합니다. 적중이면 리서처에게
정산되고, 실패면 구매자에게 **현금 환불**됩니다. 그 사이 돈은 에스크로에 있습니다.

36차 답변대로 **보상 원장(`CompensationInstruction`)을 만들었습니다.** 다만 C-3은
제안하신 것보다 **더 세게** 받았고, C-2의 한 부분과 C-1의 보완책 한 가지는 기각했습니다.
그리고 C-4에서 지목하신 경계선은 **경계가 아니었습니다** — 대신 그 파일을 다시 읽다가
다른 것을 봤습니다.

---

## A. C-4 — 지목하신 경계선은 이미 원자적입니다

> "판정 완료 시점과 정산 지시서 생성 시점 간의 원자성"

**그 사이에 시점이 둘 있지 않습니다.** `buildJudgmentWrites`는 실행하지 않고
**쓰기 연산 배열을 돌려주고**, 호출자가 `$transaction([...])`으로 한 번에 커밋합니다.
판정 레코드·정산 지시서·구매 상태·알림·(이번에 추가된) 보상 지시서가 **함께 커밋되거나
함께 사라집니다.** 멱등성은 `Judgment.predictionCardId` unique가 보장해, 중복 실행은
트랜잭션 전체가 실패하는 방식으로 막힙니다.

파일 전문은 아래 §E에 붙였습니다. 그런데 **그 파일을 다시 읽다가 다른 것을 봤습니다.**

### A-1. 제가 찾은 것 — 트랜잭션이 **구매 건수에 비례해 커집니다**

한 카드의 판정이 만드는 쓰기는 이렇습니다:

```
1 (판정) + 구매 N × 4 (정산 · 구매 상태 · 구매자 알림 · 보상 지시서) + 1 (리서처 알림)
```

N이 500이면 **한 트랜잭션에 2,000개가 넘는 쓰기**가 들어가고, 그동안 SQLite 쓰기 락이
잡혀 있습니다. 그 순간 결제가 죽습니다.

이것이 신경 쓰이는 이유는 **35차에 배운 것과 같은 실패 모양**이기 때문입니다.
`measureWriteContention` 대조군이 무너진 원인은 I/O 자체가 아니라 **트랜잭션 길이**였고,
지금 이 경로는 I/O 없이 **쓰기 개수만으로** 같은 곳에 도달합니다. 대화형 트랜잭션을
금지하는 불변식(`noIoInTransaction.test.ts`)은 이쪽을 보지 않습니다.

**지금은 결함이 아닙니다** — 리포트당 5천~5만원에 초기 판매량이면 N은 한 자릿수~수십이고,
I/O가 없는 배치 쓰기 수십 개는 밀리초 단위입니다. **다만 천장이 어디인지 아무도 모릅니다.**

고칠 자리가 있다면 **알림**이라고 봅니다 — 셋 중 알림만이 **잃어도 복구되는 쓰기**입니다
(구매자는 리포트 화면에서 같은 사실을 봅니다). 정산과 구매 상태는 어긋나면 돈이 틀리므로
절대 못 뺍니다. D-1에서 여쭙습니다.

---

## B. 이번 회차 구현 — 보상 원장

### B-1. C-2 채택 — 실행 레일만 공유

적어 주신 그림 그대로 갈랐습니다. **무엇을 공유하지 *않았는지*를 표로 적습니다** —
공유하지 않은 것마다 이유가 다르고, 그 이유가 다음에 이 코드를 고칠 사람에게 필요합니다:

| Settlement의 검사 | 보상에 넣었나 | 왜 |
|---|---|---|
| 쿨다운 48시간 | ✗ | 판정이 뒤집힐까 봐 기다리는 것인데 **뒤집힐 판정이 없다** |
| 이의 차단 | ✗ | 이의는 판정에 거는 것이라 판정 없는 건에는 성립하지 않는다 |
| PG 입금 지연 3일 | ✗ | 구매자에게 이미 전액 환불했다. 이 돈은 PG를 거치지 않는다 |
| 일일 출금 한도 | **✓** | 피해 반경은 원인을 가리지 않는다 |
| 감사 로그 | **✓** | 돈이 나가는 사건 |
| 은행 참조번호 | **✓** | 계좌이체에는 멱등키가 없다 — 시스템 밖 현금 이동의 유일한 증명 |
| 월 예산 한도 | **✓ (신설)** | 남의 돈이 아니라 **우리 손해**라, 상한이 없으면 장애 한 번이 회사를 지운다 |

금액은 `settle({outcome:'HIT'})`를 **그대로 부릅니다.** `amount - amount*bp/10000`을
손으로 적으면 반올림 규칙 하나만 달라져도 정산과 보상이 갈라지고, 갈라진 사실은
아무도 모른 채 원 단위로 쌓입니다.

### B-2. C-3은 **더 세게** 받았습니다 — 전부 사람이 확정합니다

원칙("정보 부재는 자동으로 돈이 나가는 사유가 될 수 없다")은 전면 채택입니다.
**다만 경계선을 다르게 그었습니다.** 제안하신 분류는 신호 조회가 실패한 건만
사람에게 보내는데, 저는 **네 가지 사유 전부**를 사람에게 보냅니다:

| 사유 | 검토안 | **채택안** |
|---|---|---|
| 정지 중 상한 (`SYSTEM_PAUSE`) | 자동 보상 | 사람 확정 |
| 수동 큐 방치 (`MANUAL_QUEUE`) | 자동 보상 | 사람 확정 |
| **판정 오류 (`SYSTEM_ERROR`)** | 자동 보상 | 사람 확정 |
| 시세 미확보 (`DATA_UNKNOWN`) | 사람 확정 | 사람 확정 |

근거 셋입니다:

1. **이 돈이 분 단위로 나가야 할 이유가 하나도 없습니다.** 대상은 이미 시한 후
   14~16일을 기다린 건이라, 하루 더 사람을 기다리는 것이 구조적으로 아무것도
   악화시키지 않습니다.
2. **`SYSTEM_ERROR`가 가장 위험합니다.** 분류상으로는 "우리 귀책이 확실"이지만
   그 상태는 **시스템을 가장 못 믿을 때**입니다. 버그 하나가 카드 200장을 닫으면
   보상 200건이 자동 생성됩니다 — 자동 보상 경로는 정확히 사고가 클 때 가장 크게 엽니다.
3. **자동 경로가 없으면 큐 길이 자체가 사고 규모의 계기판이 됩니다.**

덤으로, 제가 36차에 여쭌 구멍(**신호가 자주 실패하는 종목일수록 보상이 자주 나간다**)이
함께 닫혔습니다. "모르면 우리 쪽으로 기운다"는 원칙이 **지급이 아니라 큐 등재 쪽으로**
기울면서, 신호 실패가 돈으로 바뀌는 경로가 사라졌습니다.

대가는 하나 — 이 큐는 방치되면 리서처 돈이 갇히는 자리가 됩니다. 그래서 검수 보류 큐와
같은 규칙을 붙였습니다: 3일 넘게 확정 안 된 카드가 있으면 운영자 알림.
**사람을 기다리는 큐는 스스로 소리를 내야 합니다.**

### B-3. C-2의 `PENDING_BUDGET_APPROVAL` 상태는 기각했습니다

예산 한도 자체는 신설했지만 **상태로 저장하지 않습니다.**

**달이 바뀌면 예산은 리셋되는데 그 행은 스스로 안 풀립니다.** 그러면 "예산은 남았는데
상태 때문에 막힌 건"이 생기고, 그걸 푸는 배치를 또 만들어야 하고, 그 배치가 안 돌면
리서처 돈이 상태값 하나에 갇힙니다. 유예 기산점을 `updatedAt`에서 명시적 `pausedAt`으로
옮길 때 배운 것과 정확히 반대 방향의 같은 교훈입니다 — **계산으로 나오는 값을 저장하면
저장된 값이 썩습니다.**

그래서 예산 초과는 실행 시점에 계산해 던지고, 지시서는 `APPROVED`인 채로 큐에 남아
**다음 달에 그냥 나갑니다.** 사람이 할 일도 더 정직해집니다: 벽에 닿았다는 것은
이번 달에 판정을 못 한 건이 그만큼 많았다는 뜻이므로, 필요한 것은 개별 건을 밀어 넣는
승인이 아니라 **사고를 들여다보는 일**입니다.

### B-4. C-1 채택 — 다만 "한도 수동 증액 모드"는 만들지 않습니다

80% 경보는 그대로 넣었습니다(30분 주기, 하루 한 번). 지금까지 운영자가 한도를 아는
유일한 순간이 **거부당했을 때**였고, 그때는 이미 정상 지급이 막힌 뒤라 원인보다
"어떻게 올리나"부터 묻게 됩니다. 경보가 그 순서를 뒤집습니다.

**증액 모드는 기각합니다.** 이 벽이 막으려는 것이 탈취된 세션·오작동 배치인데
**그 세션이 콘솔에서 벽을 올릴 수 있으면 벽에 열쇠를 테이프로 붙여 둔 것**이 됩니다.
그리고 우회 버튼은 두 번째로 눌리는 순간 기본 동작이 됩니다(쿨다운에 예외를 두지 않은
것과 같은 이유). 한도를 올리는 일은 배포로 남고, 그 배포 자체가 사람의 판단 기록입니다.

지적하신 DoS(환불 폭주가 리서처 지급을 굶긴다)는 실재하지만 **손실이 아니라 지연**입니다 —
막힌 지시서는 큐에 그대로 남아 다음 날 나가고, 16일 약속은 *판정*까지의 약속이라
깨지지 않습니다. 그래서 처방은 벽을 올리는 것이 아니라 **순서를 정하는 것**이고,
큐는 이미 `settledAt` 오래된 순이라 가장 오래 기다린 건이 먼저 나갑니다.

---

## C. **제가 찾은 결함** — 보상이 새로운 유인을 만듭니다

구현하고 나서 스스로 깨달았고, 아직 답을 못 정했습니다.

지금 리서처의 손익은 이렇습니다:

| 결과 | 리서처가 받는 돈 | 점수 |
|---|---|---|
| 적중 | 대금 − 수수료 | + |
| 실패 | 0 (선결제분만) | − |
| **판정 불가 (우리 귀책)** | **대금 − 수수료** | **0** |

**판정 불가가 실패보다 낫고, 점수만 놓고 보면 적중보다도 안전합니다.**
그러면 **판정되기 어려운 종목을 고를 유인**이 생깁니다 — 유동성이 얕아 시세가 자주
비는 종목에 카드를 걸면, 맞으면 정상 정산이고 못 재면 보상입니다.

지금 있는 방어선 셋과 그 한계:

1. **종목 마스터** — 시세 공급자가 지원하는 종목만 게시 가능. 다만 이건 "시세를 준다"까지만
   보장하고, **자주 비는 종목**은 그대로 통과합니다
2. **같은 종목 2회 판정 불가 → 신규 게시 차단** — 사후이고, 종목 단위라 리서처가
   종목을 옮기면 다시 처음부터입니다
3. **사람이 확정** — 유일하게 이 유인을 실제로 볼 수 있는 자리입니다

제 잠정안은 **③을 강화하되 자동 규칙은 만들지 않는 것**입니다:
확정 큐에 그 리서처의 **누적 보상 이력**을 함께 띄웁니다. "N회 이상이면 자동 제외" 같은
규칙을 만들지 않는 이유는, **정직한 리서처가 우리 장애를 반복해서 겪는 것도 똑같이
N회**이기 때문입니다 — 우리 장애의 대가를 피해자에게 청구하는 규칙이 됩니다.

이 판단이 맞습니까? 아니면 유인 자체를 구조로 없애야 합니까(예: 보상액을 대금 − 수수료가
아니라 **그보다 낮게** 잡아 "판정 불가가 적중보다 낫지 않게" 만드는 것)? 후자는
36차에 확정한 D-2를 되돌리는 것이라 함부로 못 건드리겠습니다.

---

## D. 답을 듣고 싶은 것

- **D-1.** A-1의 트랜잭션 크기 — 지금 손대야 합니까, 아니면 **N의 천장을 재는 계측**부터
  넣고 실측 뒤에 정해야 합니까? 제 판단은 후자입니다(고칠 자리를 이미 아는데 지금
  고치면 "몇 장에서 문제가 되는지" 영원히 모르게 됩니다). 다만 초기 규모라 계측이
  아무 신호도 안 줄 가능성도 있어, 그럴 바엔 **알림을 트랜잭션 밖으로 빼는 것**이
  값싼 예방이라는 반론도 성립합니다. 어느 쪽입니까?
- **D-2.** §C의 유인 문제. 사람 확정에 이력을 붙이는 것으로 충분합니까?
- **D-3.** **35차 D-3이 아직 안 풀렸습니다.** 장부 대조(`reconcile`)에 **어댑터가 없어
  한 번도 실행된 적이 없습니다.** 토스 실계약 전에 이 함수의 정확성을 확인할 방법이
  있습니까? 응답 픽스처를 손으로 만드는 것은 **우리가 상상한 모양을 우리가 검증하는**
  순환이라 값어치를 잘 모르겠습니다. 전문을 §F에 붙였습니다 — 계약 전에 여기서 할 수
  있는 일이 남아 있습니까, 아니면 **이 파일은 계약까지 그대로 두는 것이 맞습니까**?
- **D-4.** 보상까지 붙어 돈이 나가는 경로가 넷이 됐습니다(지급·PG 환불·계좌 환불·보상).
  정산 영역에서 **다음에 볼 곳**은 어디입니까? 제 후보는 둘입니다 —
  ① **회계 마감**(월별로 "들어온 돈 − 나간 돈 = 남아 있어야 할 돈"을 맞춰 보는 절차가
  아예 없습니다) ② **KYC·정산 대상자 확인**(리서처에게 돈을 보내는데 그 사람이 누구인지
  확인하는 절차가 본인 인증뿐이고, 계좌 명의 대조가 없습니다). 저는 ②가 먼저라고 봅니다 —
  ①은 틀리면 나중에 고칠 수 있지만 ②는 **엉뚱한 사람에게 보낸 돈**이라 못 돌려받습니다.

---

## E. `src/server/judgmentWriter.ts` (요청하신 파일 1)

```ts
import type { Prisma, PrismaClient, PredictionCard, Purchase, Report } from '@prisma/client';
import { causeFromDataSource } from '@/domain/compensation';
import type { JudgmentResult } from '@/domain/judgment';
import { settle } from '@/domain/settlement';
import { auditOp } from './auditLog';
import { buildCompensationWrites } from './compensationService';

// 판정 결과 영속화 + 에스크로 3분기 정산 + 인앱 알림 쓰기 묶음.
// 자동 배치(judgmentBatch)와 운영자 수동 판정(manualJudgmentService)이 공유한다 —
// 어느 경로로 판정하든 점수·정산·감사 기록·알림의 형태는 동일해야 한다.

export type CardWithHeldPurchases = PredictionCard & {
  report: Report & { purchases: Purchase[]; researcher: { userId: string } };
};

const OUTCOME_LABEL: Record<string, string> = {
  HIT: '적중', MISS: '실패', UNDECIDABLE: '판정 불가',
};

export interface JudgmentRecordInput {
  result: JudgmentResult;
  realizedReturnPct: number | null;
  score: number;
  /** 가중 전 정보량 — 규율 래더의 입력 */
  info: number;
  dataSource: string;
  /** 감사·분쟁 재현용 스냅샷 */
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
    writes.push(prisma.predictionCard.update({
      where: { id: card.id }, data: { basePrice: input.resolvedBasePrice },
    }));
  }

  // 에스크로 3분기 정산 — 금액 보존 불변식은 settle()이 보장.
  // 환불은 항상 현금(확정) — Settlement 기록이 PG 취소/계좌이체 지시서 역할.
  const label = OUTCOME_LABEL[result.outcome] ?? result.outcome;
  let payoutTotal = 0;
  let refundTotal = 0;

  for (const p of card.report.purchases) {
    const s = settle({
      amountKrw: p.amountKrw,
      feeRateBp: card.report.feeRateBp!,
      prepaymentRatio: card.report.prepaymentRatio,
      outcome: result.outcome,
    });
    payoutTotal += s.researcherPayoutKrw;
    refundTotal += s.buyerRefundKrw;
    writes.push(
      prisma.settlement.create({
        data: {
          purchaseId: p.id, outcome: s.outcome,
          researcherPayoutKrw: s.researcherPayoutKrw,
          platformFeeKrw: s.platformFeeKrw,
          buyerRefundKrw: s.buyerRefundKrw,
          refundType: s.refundType, settledAt: now,
        },
      }),
      prisma.purchase.update({
        where: { id: p.id },
        data: { escrowStatus: s.buyerRefundKrw === p.amountKrw ? 'REFUNDED' : 'SETTLED' },
      }),
      // 구매자 알림: 환불 인지가 서비스 신뢰의 핵심
      prisma.notification.create({
        data: {
          userId: p.buyerId, type: 'JUDGMENT_RESULT',
          title: `구매 리포트 판정: ${card.assetName} ${label}`,
          body: result.outcome === 'HIT'
              ? '예측이 적중했습니다. 결제액은 리서처에게 정산됩니다.'
              : result.outcome === 'MISS'
                ? `예측이 빗나갔습니다. ${s.buyerRefundKrw.toLocaleString()}원이 현금 환불됩니다.`
                : `판정 불가 처리되었습니다. 전액(${s.buyerRefundKrw.toLocaleString()}원)이 환불됩니다.`,
          link: `/report/${card.reportId}`, createdAt: now,
        },
      }),
    );
  }

  // 리서처 알림: 판정 결과 + 점수 + 정산 요약
  const settleSummary =
    card.report.purchases.length === 0 ? '판매된 구매 건이 없습니다.'
      : payoutTotal > 0
        ? `${payoutTotal.toLocaleString()}원이 정산됩니다 (구매 ${card.report.purchases.length}건).`
        : `구매 ${card.report.purchases.length}건, ${refundTotal.toLocaleString()}원이 구매자에게 환불됩니다.`;

  // **얼마나 갔었는지를 말해 준다.** 전에는 실패 알림이 "점수 −N점, 0원 정산"뿐이라
  // +9.8%로 끝난 사람과 −30%로 끝난 사람이 똑같은 문장을 받았다.
  // ⚠ 처분은 하나도 바꾸지 않는다 — 근접을 봐주면 "목표의 몇 %까지는 맞은 셈"이라는
  // 새 경계가 생기고, 경계가 생기면 그 경계를 노리는 신고가 생긴다.
  const peak = result.outcome === 'MISS' ? result.peakProgress : undefined;
  const peakNote = peak !== undefined && peak > 0
      ? ` 목표까지 ${Math.min(99, Math.round(peak * 100))}% 지점(종가 기준)이 최고였습니다.` : '';
  writes.push(prisma.notification.create({
    data: {
      userId: card.report.researcher.userId, type: 'JUDGMENT_RESULT',
      title: `예측 판정: ${card.assetName} ${label}`,
      body: `점수 ${input.score > 0 ? '+' : ''}${Math.round(input.score)}점. ${settleSummary}${peakNote}`,
      link: `/researcher/${card.report.researcherId}`, createdAt: now,
    },
  }));

  // ── **우리 사정으로 못 쟀으면 보상 지시서도 같은 트랜잭션에서 태어난다** (2026-08-16) ──
  //
  // 여기에 두는 이유는 **하드캡 경로가 셋이기 때문**이다(정지 중 / 수동 큐 / 시세 미확보·
  // 오류). 호출자마다 보상 생성을 붙이면 언젠가 한 곳이 빠지고, 빠진 자리는 **닫힌 카드가
  // 정상 판정과 똑같이 보여** 아무도 못 찾는다.
  //
  // 갈라내는 기준은 `dataSource` 하나다 — 결과(UNDECIDABLE)로 가르면 상장폐지·강제
  // 철회처럼 **우리 탓이 아닌 판정 불가**까지 보상 대상이 된다.
  const cause = causeFromDataSource(input.dataSource);
  if (cause) writes.push(...buildCompensationWrites(prisma, card, cause, now));

  // **사람이 매긴 판정만 감사 로그에 남긴다.** 처음에는 자동 판정도 남겼는데 그 기준으로는
  // 정상 하루치가 통째로 들어온다 — 감사 로그는 평화로울 때 침묵해야 개입이 눈에 띈다.
  // 자르는 선을 *행위*가 아니라 **행위자**에 둔 것이 요점이다: 같은 Judgment 행을
  // 만들어도 배치가 하면 기록이고 사람이 하면 사건이다.
  const operator = input.dataSource.startsWith('manual:')
    ? input.dataSource.slice('manual:'.length) : null;
  if (operator) {
    writes.push(auditOp(prisma, {
      actor: operator, actorType: 'OPERATOR', action: 'MANUAL_JUDGMENT',
      targetType: 'PredictionCard', targetId: card.id,
      after: {
        outcome: result.outcome, settledPrice: result.settledPrice ?? null,
        score: Math.round(input.score), payoutKrw: payoutTotal, refundKrw: refundTotal,
        purchases: card.report.purchases.length,
      },
      at: now,
    }));
  }

  return writes;
}
```

---

## F. `src/domain/reconciliation.ts` (요청하신 파일 2 — 어댑터 없음)

```ts
// PG 장부 ↔ 우리 장부 대조 — **순수 함수.** DB도 API도 모른다.
//
// 왜 지금 짜나: 실제 결제가 아직 없어 정산 API 응답의 모양을 본 적이 없다. 그런데
// **어긋남을 찾아내는 계산 자체는 응답 모양과 무관하다** — 두 목록의 차이를 내는 일이다.
// 어댑터(토스 응답 → LedgerEntry[])만 실계약 후에 붙이면 된다.
//
// 무엇이 어긋나게 만드나 (전부 우리 코드 밖에서 일어난다):
//  · **차지백** — 구매자가 카드사에 이의를 걸면 PG 장부에서 돈이 빠지는데 우리는 모른다
//  · **콘솔 수동 취소** — 사람이 토스 콘솔에서 직접 취소한 건
//  · **승인 응답 유실** — 돈은 빠졌는데 우리 쪽 기록이 안 남은 건 (멱등키가 줄이지만 0은 아니다)
// 셋 다 **우리 코드가 아무리 정확해도 생긴다.** 그래서 대조는 버그를 잡는 장치가 아니라
// 바깥과 우리를 맞추는 상시 장치다.
//
// **자동 보정은 하지 않는다.** 이 파일에는 쓰기가 한 줄도 없다 — 어긋남을 발견했을 때
// 시스템이 스스로 장부를 맞추면, 나중에 "돈이 어디서 왜 비었나"를 추적할 수 없게 된다.

export type EntryKind = 'PAYMENT' | 'REFUND';

/** 대조 단위 한 줄 — 우리 장부와 PG 장부가 같은 모양으로 들어온다 */
export interface LedgerEntry { paymentKey: string; kind: EntryKind; amountKrw: number; }

export type MismatchCode =
  /** PG에는 있는데 우리 장부에 없다 — 우리가 모르는 돈 (차지백·콘솔 수동취소) */
  | 'MISSING_IN_LEDGER'
  /** 우리 장부에는 있는데 PG에 없다 — **더 위험하다.** 팔았다고 아는데 돈이 안 들어왔다 */
  | 'MISSING_IN_PG'
  /** 양쪽에 있는데 금액이 다르다 — 부분 취소가 우리 기록과 어긋난 경우가 대부분 */
  | 'AMOUNT_DIFFERS';

export interface Mismatch {
  paymentKey: string; kind: EntryKind; code: MismatchCode;
  ledgerKrw: number | null; pgKrw: number | null;
  /** 사람이 읽는 한 줄 — 알림에 그대로 실린다 */
  message: string;
}

export interface ReconcileResult {
  matched: number; mismatches: Mismatch[];
  ledgerTotalKrw: number; pgTotalKrw: number;
  /** 순액 차이 (우리 − PG). 0이 아니면 반드시 mismatches가 비어 있지 않다 */
  differenceKrw: number;
}

const KIND_LABEL: Record<EntryKind, string> = { PAYMENT: '결제', REFUND: '환불' };

/**
 * **같은 결제의 여러 줄을 합친다.** 부분 취소는 한 paymentKey에 환불 줄이 여럿 생기므로
 * 1:1로 맞추려 하면 정상인데도 어긋난 것처럼 보인다. (결제, 환불) 단위로 합계를 내
 * 비교하면 몇 번에 나눠 취소했든 총액이 같으면 맞는 것이다.
 */
function sumByKey(entries: LedgerEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    const k = `${e.kind}:${e.paymentKey}`;
    m.set(k, (m.get(k) ?? 0) + e.amountKrw);
  }
  return m;
}

function net(entries: LedgerEntry[]): number {
  return entries.reduce((s, e) => s + (e.kind === 'PAYMENT' ? e.amountKrw : -e.amountKrw), 0);
}

/**
 * 두 장부를 맞춰 본다.
 *
 * **오차 허용치를 두지 않는다.** 1원이 비는 것은 반올림이 아니라 규칙이 어긋났다는 신호다 —
 * 여기서 몇 원을 봐주기 시작하면 그 폭 안에서는 영원히 아무것도 못 잡는다.
 */
export function reconcile(ledger: LedgerEntry[], pg: LedgerEntry[]): ReconcileResult {
  const ours = sumByKey(ledger);
  const theirs = sumByKey(pg);
  const mismatches: Mismatch[] = [];
  let matched = 0;

  for (const key of new Set([...ours.keys(), ...theirs.keys()])) {
    const [kindRaw, paymentKey] = key.split(/:(.+)/);
    const kind = kindRaw as EntryKind;
    const a = ours.get(key) ?? null;
    const b = theirs.get(key) ?? null;
    const label = KIND_LABEL[kind];

    if (a === null) {
      mismatches.push({ paymentKey, kind, code: 'MISSING_IN_LEDGER', ledgerKrw: null, pgKrw: b,
        message: `PG에만 있는 ${label} ${b!.toLocaleString()}원 — 우리가 모르는 돈입니다 (차지백·콘솔 수동취소를 의심하세요)` });
    } else if (b === null) {
      mismatches.push({ paymentKey, kind, code: 'MISSING_IN_PG', ledgerKrw: a, pgKrw: null,
        message: `우리 장부에만 있는 ${label} ${a.toLocaleString()}원 — PG는 모르는 건입니다 (팔았는데 돈이 안 들어왔을 수 있습니다)` });
    } else if (a !== b) {
      mismatches.push({ paymentKey, kind, code: 'AMOUNT_DIFFERS', ledgerKrw: a, pgKrw: b,
        message: `${label} 금액 불일치 — 우리 ${a.toLocaleString()}원 / PG ${b.toLocaleString()}원 (차이 ${(a - b).toLocaleString()}원)` });
    } else {
      matched++;
    }
  }

  // 사람이 먼저 봐야 하는 순서로 — "돈이 안 들어왔다"가 "모르는 취소"보다 급하다
  const ORDER: MismatchCode[] = ['MISSING_IN_PG', 'AMOUNT_DIFFERS', 'MISSING_IN_LEDGER'];
  mismatches.sort((x, y) => ORDER.indexOf(x.code) - ORDER.indexOf(y.code));

  const ledgerTotalKrw = net(ledger);
  const pgTotalKrw = net(pg);
  return { matched, mismatches, ledgerTotalKrw, pgTotalKrw,
    differenceKrw: ledgerTotalKrw - pgTotalKrw };
}
```

---

## 참고 — 지금 상태

- 테스트 **1,007건** 통과(+24), 타입체크·린트 통과, 리허설 9단계 종주
- 이번 회차 구현: `prisma/schema.prisma`(CompensationInstruction + 마이그레이션),
  `src/domain/compensation.ts`, `src/server/compensationService.ts`,
  `src/server/compensationBudget.ts`, `src/server/payoutVelocity.ts`(4경로 합산 + 80% 경보),
  `src/server/judgmentWriter.ts`, `scripts/runScheduler.ts`
- **코드 밖 블로커는 그대로입니다** — 업권 판단 미확정, 본인 인증 실공급자 미계약,
  약관 본문 자리표시자, 토스 실키 미발급, 가출원·상표 미착수.
  D-4의 후보 ②(KYC·계좌 명의 대조)는 이 중 **본인 인증 실공급자**와 직접 맞닿아 있어,
  코드로 갈 수 있는 데까지만 가고 나머지는 계약 뒤로 남습니다
