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
// 여기가 하는 일은 **찾아서 이름 붙여 내미는 것**까지다.

export type EntryKind = 'PAYMENT' | 'REFUND';

/** 대조 단위 한 줄 — 우리 장부와 PG 장부가 같은 모양으로 들어온다 */
export interface LedgerEntry {
  paymentKey: string;
  kind: EntryKind;
  amountKrw: number;
}

export type MismatchCode =
  /** PG에는 있는데 우리 장부에 없다 — 우리가 모르는 돈 (차지백·콘솔 수동취소가 여기로 온다) */
  | 'MISSING_IN_LEDGER'
  /** 우리 장부에는 있는데 PG에 없다 — **더 위험하다.** 팔았다고 아는데 돈이 안 들어왔다 */
  | 'MISSING_IN_PG'
  /** 양쪽에 있는데 금액이 다르다 — 부분 취소가 우리 기록과 어긋난 경우가 대부분 */
  | 'AMOUNT_DIFFERS';

export interface Mismatch {
  paymentKey: string;
  kind: EntryKind;
  code: MismatchCode;
  ledgerKrw: number | null;
  pgKrw: number | null;
  /** 사람이 읽는 한 줄 — 알림에 그대로 실린다 */
  message: string;
}

export interface ReconcileResult {
  /** 금액까지 정확히 맞은 항목 수 */
  matched: number;
  mismatches: Mismatch[];
  ledgerTotalKrw: number;
  pgTotalKrw: number;
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
      mismatches.push({
        paymentKey,
        kind,
        code: 'MISSING_IN_LEDGER',
        ledgerKrw: null,
        pgKrw: b,
        message: `PG에만 있는 ${label} ${b!.toLocaleString()}원 — 우리가 모르는 돈입니다 (차지백·콘솔 수동취소를 의심하세요)`,
      });
    } else if (b === null) {
      mismatches.push({
        paymentKey,
        kind,
        code: 'MISSING_IN_PG',
        ledgerKrw: a,
        pgKrw: null,
        message: `우리 장부에만 있는 ${label} ${a.toLocaleString()}원 — PG는 모르는 건입니다 (팔았는데 돈이 안 들어왔을 수 있습니다)`,
      });
    } else if (a !== b) {
      mismatches.push({
        paymentKey,
        kind,
        code: 'AMOUNT_DIFFERS',
        ledgerKrw: a,
        pgKrw: b,
        message: `${label} 금액 불일치 — 우리 ${a.toLocaleString()}원 / PG ${b.toLocaleString()}원 (차이 ${(a - b).toLocaleString()}원)`,
      });
    } else {
      matched++;
    }
  }

  // 사람이 먼저 봐야 하는 순서로 — "돈이 안 들어왔다"가 "모르는 취소"보다 급하다
  const ORDER: MismatchCode[] = ['MISSING_IN_PG', 'AMOUNT_DIFFERS', 'MISSING_IN_LEDGER'];
  mismatches.sort((x, y) => ORDER.indexOf(x.code) - ORDER.indexOf(y.code));

  const ledgerTotalKrw = net(ledger);
  const pgTotalKrw = net(pg);
  return {
    matched,
    mismatches,
    ledgerTotalKrw,
    pgTotalKrw,
    differenceKrw: ledgerTotalKrw - pgTotalKrw,
  };
}
