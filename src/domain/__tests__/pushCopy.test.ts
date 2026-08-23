import { describe, expect, it } from 'vitest';
import {
  hasDigits,
  PUSH_COPY_TYPES,
  pushCopyFor,
  shouldPush,
} from '../pushCopy';

// 이 시험이 지키는 것은 문구의 예쁨이 아니라 **잠금화면에 뜨면 안 되는 것**이다.

describe('푸시 문구', () => {
  it('어떤 문구에도 숫자가 없다 — 금액·계좌 뒷자리·종목 코드는 전부 숫자를 낀다', () => {
    for (const type of PUSH_COPY_TYPES) {
      const c = pushCopyFor(type);
      expect(hasDigits(c.title), `${type} 제목에 숫자: "${c.title}"`).toBe(false);
      expect(hasDigits(c.body), `${type} 본문에 숫자: "${c.body}"`).toBe(false);
    }
  });

  it('모르는 종류는 가장 안전한 기본값으로 떨어진다 — 안전이 기본이라 빠뜨려도 새지 않는다', () => {
    const c = pushCopyFor('WHATEVER_NEW_TYPE_2027');
    expect(c.title).toBe('인투빌에 새 알림이 있어요');
    expect(c.urgent).toBe(false);
  });

  it('돈이 걸린 보안 알림만 급하게 울린다 — 전부 울리면 아무것도 안 울리는 것과 같다', () => {
    expect(pushCopyFor('PAYOUT_ACCOUNT_CHANGED').urgent).toBe(true);
    expect(pushCopyFor('RISKY_LOGIN').urgent).toBe(true);
    expect(pushCopyFor('JUDGMENT_RESULT').urgent).toBe(false);
    expect(pushCopyFor('REFUND_EXECUTED').urgent).toBe(false);

    const urgentCount = PUSH_COPY_TYPES.filter((t) => pushCopyFor(t).urgent).length;
    expect(urgentCount).toBeLessThan(PUSH_COPY_TYPES.length / 2);
  });

  it('계좌 변경 알림은 무엇을 해야 하는지까지 말한다 — 뭉개면 동결할 기회를 잃는다', () => {
    const c = pushCopyFor('PAYOUT_ACCOUNT_CHANGED');
    expect(c.title).toContain('정산 계좌');
    expect(c.body).toContain('동결');
  });

  it('운영자 전용 알림은 푸시로 안 나간다 — 텔레그램과 겹치면 하나를 무시하게 된다', () => {
    expect(shouldPush('OPS_ALERT')).toBe(false);
    expect(shouldPush('JUDGMENT_RESULT')).toBe(true);
  });

  it('hasDigits가 실제로 숫자를 잡는다 (이 시험 자체의 전제)', () => {
    expect(hasDigits('환불 12,900원이 처리됐어요')).toBe(true);
    expect(hasDigits('환불이 처리됐어요')).toBe(false);
  });
});
