import { describe, expect, it } from 'vitest';
import { assertNoDevGatesInProduction, passkeyGateBypassed } from '../devGates';
import { assertProductionSecrets } from '../envBootCheck';

// 개발용 패스키 관문 우회 스위치 — **출시 빌드로 새어 나가는 길이 없는가**만 잰다.
//
// 이 스위치는 보안 관문을 여는 값이라, 실수 한 번의 대가가 "관리 화면이 지문 없이
// 열린다"이다. 그래서 방어가 두 겹이고, 이 시험은 **두 겹 다** 붙잡는다 —
// 한 겹만 시험하면 나중에 다른 겹이 조용히 사라져도 초록불이 켜진다.

const prod = (extra: Record<string, string> = {}) =>
  ({ NODE_ENV: 'production', ...extra }) as unknown as NodeJS.ProcessEnv;
const dev = (extra: Record<string, string> = {}) =>
  ({ NODE_ENV: 'development', ...extra }) as unknown as NodeJS.ProcessEnv;

describe('① 런타임 — 운영에서는 값이 있어도 무시한다', () => {
  it('개발 + 스위치 → 우회한다', () => {
    expect(passkeyGateBypassed(dev({ DEV_SKIP_PASSKEY_GATE: '1' }))).toBe(true);
  });

  it('운영 + 스위치 → 우회하지 않는다', () => {
    expect(passkeyGateBypassed(prod({ DEV_SKIP_PASSKEY_GATE: '1' }))).toBe(false);
  });

  it('스위치가 없으면 개발에서도 관문은 살아 있다 — 기본값은 잠김이다', () => {
    expect(passkeyGateBypassed(dev())).toBe(false);
  });

  it('정확히 "1"일 때만 열린다 — true·yes 같은 값으로 우연히 열리지 않게', () => {
    for (const v of ['0', 'true', 'yes', '', 'on']) {
      expect(passkeyGateBypassed(dev({ DEV_SKIP_PASSKEY_GATE: v }))).toBe(false);
    }
  });
});

describe('② 부팅 — 운영에 스위치가 남아 있으면 서버가 뜨지 않는다', () => {
  it('운영 + 스위치 → 부팅 거부', () => {
    expect(() => assertNoDevGatesInProduction(prod({ DEV_SKIP_PASSKEY_GATE: '1' }))).toThrow(
      /DEV_SKIP_PASSKEY_GATE/,
    );
  });

  // ①이 리팩터링으로 사라져도 여기서 걸린다 — 값이 무엇이든 운영에 있으면 안 된다
  it('값이 "0"이어도 운영에서는 거부한다 — 존재 자체가 실수 신호다', () => {
    expect(() => assertNoDevGatesInProduction(prod({ DEV_SKIP_PASSKEY_GATE: '0' }))).toThrow();
  });

  it('개발에서는 막지 않는다', () => {
    expect(() => assertNoDevGatesInProduction(dev({ DEV_SKIP_PASSKEY_GATE: '1' }))).not.toThrow();
  });

  // 실제 부팅 경로(instrumentation → assertProductionSecrets)가 이 검사를 부르는가.
  // 따로 부르는 함수라 목록 래칫에 안 실려서, 배선 자체를 여기서 붙잡는다
  it('부팅 검사가 실제로 이 검사를 부른다', () => {
    const full = prod({
      AUTH_SECRET: 's',
      IDENTITY_PEPPER: 'p',
      PAYOUT_ENC_KEY: 'a'.repeat(64),
      NEXT_PUBLIC_APP_ORIGIN: 'https://intovill.example',
      DEV_SKIP_PASSKEY_GATE: '1',
    });
    expect(() => assertProductionSecrets(full)).toThrow(/DEV_SKIP_PASSKEY_GATE/);
  });
});
