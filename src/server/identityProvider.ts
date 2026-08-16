import { createHash } from 'node:crypto';

// 본인 인증 공급자 추상화.
// 실제로는 PASS(통신사)·NICE평가정보 등이 CI(연계정보 — 사람마다 고유·서비스 무관)를
// 반환한다. CI가 같으면 같은 사람이므로 1인 1계정 강제의 기준이 된다.
// 계약 전에는 스텁으로 대체하되, 인터페이스는 실제 공급자와 동일하게 유지한다.

export interface IdentityVerificationInput {
  name: string;
  /** 휴대폰 번호 (하이픈 무관) */
  phone: string;
}

export interface IdentityVerificationResult {
  /** 연계정보(CI) — 사람 고유. 절대 원문 저장 금지, 해시만 보관 */
  ci: string;
  name: string;
  phone: string;
}

export interface IdentityProvider {
  readonly providerId: string;
  verify(input: IdentityVerificationInput): Promise<IdentityVerificationResult>;
}

/** 전화번호 정규화 (숫자만) */
export function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, '');
}

/**
 * 개발·테스트용 스텁: 전화번호로부터 결정적 CI를 만든다.
 * → 같은 번호로 재인증하면 같은 CI가 나와 "계정 재생성 성적 세탁"이 차단되는지
 *   실제 공급자 없이도 검증할 수 있다. 실서비스에서는 PASS/NICE 어댑터로 교체.
 */
export class StubIdentityProvider implements IdentityProvider {
  readonly providerId = 'stub';

  async verify(input: IdentityVerificationInput): Promise<IdentityVerificationResult> {
    const phone = normalizePhone(input.phone);
    if (phone.length < 10) {
      throw new Error('유효한 휴대폰 번호가 아닙니다');
    }
    if (input.name.trim().length === 0) {
      throw new Error('이름을 입력해주세요');
    }
    // 실제 CI를 흉내 낸 결정적 값 (번호 기반). 실 공급자는 사람 고유값을 반환한다.
    const ci = createHash('sha256').update(`stub-ci:${phone}`).digest('base64');
    return { ci, name: input.name.trim(), phone };
  }
}

/**
 * 지금 쓸 본인 인증 공급자 — **고르는 자리는 여기 하나다.**
 *
 * 부르는 곳마다 스텁을 직접 만들면 실공급자로 갈아 끼울 때 그중 하나를 빠뜨리게 되고,
 * 빠뜨린 경로만 조용히 스텁으로 남는다. 그 경로가 하필 **계좌 등록**이면 아무것도
 * 막지 못하는 관문이 된다 — 겉보기에는 인증을 하고 있으므로 눈치채기도 어렵다.
 */
export function createDefaultIdentityProvider(): IdentityProvider {
  return new StubIdentityProvider();
}
