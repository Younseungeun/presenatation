import { describe, expect, it } from 'vitest';
import { reconcile, type LedgerEntry } from '../reconciliation';

// **우리 코드가 아무리 정확해도 장부는 어긋난다.** 차지백·콘솔 수동취소·승인 응답 유실은
// 전부 우리 밖에서 일어나기 때문이다. 그래서 대조는 버그를 잡는 장치가 아니라 상시 장치다.

const pay = (paymentKey: string, amountKrw: number): LedgerEntry => ({
  paymentKey,
  kind: 'PAYMENT',
  amountKrw,
});
const refund = (paymentKey: string, amountKrw: number): LedgerEntry => ({
  paymentKey,
  kind: 'REFUND',
  amountKrw,
});

describe('PG 장부 대조', () => {
  it('완전히 맞으면 어긋남이 없다', () => {
    const rows = [pay('p1', 10_000), pay('p2', 30_000), refund('p1', 10_000)];
    const r = reconcile(rows, [...rows]);
    expect(r.mismatches).toHaveLength(0);
    expect(r.matched).toBe(3);
    expect(r.differenceKrw).toBe(0);
  });

  // **부분 취소는 한 결제에 환불 줄을 여럿 만든다.** 1:1로 맞추려 하면 정상인데도
  // 어긋난 것처럼 보이므로 (결제, 환불) 단위 합계로 비교한다
  it('나눠서 취소한 것과 한 번에 취소한 것을 같게 본다', () => {
    const ours = [pay('p1', 10_000), refund('p1', 3_000), refund('p1', 4_000)];
    const theirs = [pay('p1', 10_000), refund('p1', 7_000)];
    expect(reconcile(ours, theirs).mismatches).toHaveLength(0);
  });

  // 차지백이 들어오는 자리 — PG 장부에서는 돈이 빠지는데 우리는 아무것도 모른다
  it('PG에만 있는 환불을 잡는다 — 우리가 모르는 돈', () => {
    const r = reconcile([pay('p1', 10_000)], [pay('p1', 10_000), refund('p1', 10_000)]);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0].code).toBe('MISSING_IN_LEDGER');
    expect(r.mismatches[0].message).toContain('차지백');
    expect(r.differenceKrw).toBe(10_000); // 우리가 1만원 더 있다고 믿는 중
  });

  // **이쪽이 더 위험하다** — 리포트는 나갔는데 돈이 안 들어왔다는 뜻이다
  it('우리 장부에만 있는 결제를 잡고, 더 급한 것으로 앞에 세운다', () => {
    const r = reconcile(
      [pay('p1', 10_000), pay('p2', 20_000)],
      [pay('p2', 20_000), refund('p3', 5_000)],
    );
    expect(r.mismatches).toHaveLength(2);
    // 정렬: "돈이 안 들어왔다"가 "모르는 취소"보다 먼저 보여야 한다
    expect(r.mismatches[0].code).toBe('MISSING_IN_PG');
    expect(r.mismatches[1].code).toBe('MISSING_IN_LEDGER');
  });

  // **1원도 봐주지 않는다.** 반올림이 아니라 규칙이 어긋났다는 신호이고,
  // 폭을 두기 시작하면 그 안에서는 영원히 아무것도 못 잡는다
  it('1원 차이도 잡는다', () => {
    const r = reconcile([pay('p1', 10_000)], [pay('p1', 9_999)]);
    expect(r.mismatches).toHaveLength(1);
    expect(r.mismatches[0].code).toBe('AMOUNT_DIFFERS');
    expect(r.differenceKrw).toBe(1);
  });

  // paymentKey에 콜론이 들어와도 키가 쪼개지면 안 된다 (구분자로 콜론을 쓴다)
  it('구분자가 들어간 결제 키도 안전하게 되돌린다', () => {
    const key = 'tviva:2026:0814:abc';
    const r = reconcile([pay(key, 1_000)], [pay(key, 2_000)]);
    expect(r.mismatches[0].paymentKey).toBe(key);
  });

  // 순액이 우연히 같아도 구성이 다르면 어긋난 것이다 — 총액만 보면 이걸 놓친다
  it('총액이 같아도 구성이 다르면 잡는다', () => {
    const r = reconcile([pay('p1', 10_000)], [pay('p2', 10_000)]);
    expect(r.differenceKrw).toBe(0);
    expect(r.mismatches).toHaveLength(2); // p1은 PG에 없고, p2는 우리에 없다
  });

  it('빈 장부끼리는 조용하다 — 정산이 없는 날에 경보가 뜨면 안 된다', () => {
    const r = reconcile([], []);
    expect(r.mismatches).toHaveLength(0);
    expect(r.matched).toBe(0);
  });
});
