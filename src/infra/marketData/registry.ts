import type { ProviderRegistry } from '@/domain/marketData';
import { BithumbMarketDataProvider } from './bithumbProvider';
import { KisMarketDataProvider } from './kisProvider';
import { StooqMarketDataProvider } from './stooqProvider';
import { UpbitMarketDataProvider } from './upbitProvider';

/**
 * 환경 변수 기반 기본 공급자 레지스트리.
 * - CRYPTO: 업비트 (키 불필요, 항상 등록)
 * - KR_EQUITY / US_EQUITY: 한국투자증권 KIS (KIS_APP_KEY + KIS_APP_SECRET 한 쌍으로 둘 다)
 * - US_EQUITY 폴백: 키가 없을 때 개발 모드에 한해 Stooq (프로덕션에서는 절대 폴백하지 않는다)
 * 미등록 자산군의 게시·판정은 명시적 에러로 실패한다 (조용한 오동작 방지).
 *
 * **KIS 하나가 국내·미국을 모두 담당한다** (2026-08-10 전환).
 * 이전에는 국내=공공데이터포털(금융위), 미국=Twelve Data였는데 둘 다 문제가 있었다:
 *  · 금융위 시세는 D+1 지연이라 장중 보호(결제 순간 차단)가 원천적으로 불가능
 *  · Twelve Data 무료는 분당 8회라 종목 24개를 도는 배치가 매번 다른 결과를 냈다
 *    (요율 초과분이 조용히 건너뛰어져 판매 마감이 무작위로 적용됐다)
 * KIS는 국내 실시간 + 미국 0분 지연 실시간을 무료로 주고 초당 1회를 허용한다.
 */
export function createDefaultRegistry(env = process.env): ProviderRegistry {
  const registry: ProviderRegistry = {
    CRYPTO: new UpbitMarketDataProvider(),
  };

  const { KIS_APP_KEY, KIS_APP_SECRET } = env;
  if (KIS_APP_KEY && KIS_APP_SECRET) {
    // 자산군마다 인스턴스를 따로 둔다 — 토큰은 공유해도 되지만 거래소 힌트 캐시와
    // 호출 큐가 자산군별로 분리되어야 한쪽 장애가 다른 쪽을 밀어내지 않는다
    registry.KR_EQUITY = new KisMarketDataProvider(KIS_APP_KEY, KIS_APP_SECRET, 'KR');
    registry.US_EQUITY = new KisMarketDataProvider(KIS_APP_KEY, KIS_APP_SECRET, 'US');
  } else if (env.NODE_ENV !== 'production') {
    // Stooq는 개발·검증 전용 — 프로덕션에서는 절대 폴백하지 않는다
    registry.US_EQUITY = new StooqMarketDataProvider();
  }

  return registry;
}

/**
 * **판정 교차검증용 두 번째 소스** (domain/crossCheck.ts). 주 레지스트리와 겹치지 않는다.
 *
 * 자산군마다 채워지는 시점이 다르다 — 지금 계약 없이 붙일 수 있는 것은 코인(빗썸)뿐이다:
 *  · CRYPTO     빗썸 공개 API (키 불필요) — **채워짐**
 *  · KR_EQUITY  공공데이터포털(금융위)이 후보. 상업 이용 조건 미확인 (CLAUDE.md §6.5)
 *  · US_EQUITY  운영 소스 자체가 계약 전 (Alpaca·Twelve Data)
 *
 * 비어 있는 자산군은 교차검증이 `NO_SECONDARY`로 지나간다 — **판정을 멈추지 않는다.**
 * 두 번째 증인이 없다고 재판을 못 여는 것은 아니고, 없었다는 사실은 감사 기록에 남는다.
 *
 * 주 소스와 **같은 소스를 두 번 부르는 일이 없어야 한다** — 그러면 대조가 아니라
 * 자기 확인이 되어, 통과했다는 사실이 아무것도 보증하지 않으면서 호출만 두 배가 된다.
 */
export function createSecondaryRegistry(env = process.env): ProviderRegistry {
  const registry: ProviderRegistry = {};

  // 명시적으로 끌 수 있어야 한다 — 빗썸이 죽었을 때 배포를 기다릴 수 없다
  if (env.CROSS_CHECK_CRYPTO_DISABLED !== '1') {
    registry.CRYPTO = new BithumbMarketDataProvider();
  }

  return registry;
}
