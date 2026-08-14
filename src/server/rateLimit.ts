// 호출 빈도 제한 — **결제 관문 전용이지 일반 API 보호가 아니다.**
//
// 막으려는 것은 부하가 아니라 **카드 테스팅**이다: 도난 카드 목록을 들고 와서
// 1초에 수십 번 결제를 시도해 살아 있는 카드를 골라내는 짓. 실제 현금이 오가기
// 시작하면 이건 "언젠가 있을 일"이 아니라 **첫 주에 오는 일**이고, 당하면 PG사
// 계약이 걸린다(승인 실패율이 높으면 가맹점 자격 자체가 위험하다).
//
// **한계를 분명히 적어 둔다**: 저장소가 프로세스 메모리라 웹 서버를 여러 대로
// 늘리면 대수만큼 곱해진다. 그때는 Redis로 옮겨야 한다. 그래도 지금 넣는 이유는
// **"없는 것"과 "1/N만큼 있는 것"의 차이가 크기 때문**이다 — 초당 50회를 초당
// 몇 회로 깎는 것만으로도 이 공격은 채산이 안 맞는다.

export interface RateLimitRule {
  /** 창 안에서 허용할 횟수 */
  limit: number;
  windowMs: number;
}

/**
 * 결제를 유발하는 엔드포인트의 기본 규칙.
 *
 * 정상 사용자는 리포트를 사는 데 1분에 몇 번을 넘길 이유가 없다 — 장바구니가 있어
 * 여러 건도 한 번에 나간다. 넉넉히 잡아도 공격에는 충분히 촘촘하다.
 */
export const CHECKOUT_RULE: RateLimitRule = { limit: 10, windowMs: 60_000 };

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Map<string, Window>>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

/**
 * 한 번의 시도를 세고 허용 여부를 돌려준다.
 *
 * 고정 창(fixed window)이다 — 창 경계에서 최대 2배가 몰릴 수 있다는 것을 알고 쓴다.
 * 슬라이딩 창은 요청마다 타임스탬프 배열을 들고 있어야 하는데, 여기서 지키려는 것이
 * "정확히 10회"가 아니라 **"초당 수십 회를 못 하게"** 라서 그 정밀도가 필요 없다.
 */
export function hitRateLimit(
  bucket: string,
  key: string,
  rule: RateLimitRule = CHECKOUT_RULE,
  now = Date.now(),
): RateLimitResult {
  let b = buckets.get(bucket);
  if (!b) {
    b = new Map();
    buckets.set(bucket, b);
  }
  // 창이 지난 항목을 그때그때 걷어낸다 — 청소 타이머를 따로 두지 않기 위해서다.
  // 키가 사용자·IP라 무한정 늘 수 있는데, 한 창이 지나면 다음 접근에서 사라진다
  if (b.size > 10_000) {
    for (const [k, w] of b) if (w.resetAt <= now) b.delete(k);
  }

  const w = b.get(key);
  if (!w || w.resetAt <= now) {
    b.set(key, { count: 1, resetAt: now + rule.windowMs });
    return { ok: true, remaining: rule.limit - 1, retryAfterMs: 0 };
  }
  w.count += 1;
  if (w.count > rule.limit) {
    return { ok: false, remaining: 0, retryAfterMs: w.resetAt - now };
  }
  return { ok: true, remaining: rule.limit - w.count, retryAfterMs: 0 };
}

/** 시험 전용 — 창을 비운다 */
export function resetRateLimits(): void {
  buckets.clear();
}
