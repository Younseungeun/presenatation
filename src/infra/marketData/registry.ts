import type { ProviderRegistry } from '@/domain/marketData';
import { FscMarketDataProvider } from './fscProvider';
import { StooqMarketDataProvider } from './stooqProvider';
import { TwelveDataMarketDataProvider } from './twelveDataProvider';
import { UpbitMarketDataProvider } from './upbitProvider';

/**
 * 환경 변수 기반 기본 공급자 레지스트리.
 * - CRYPTO: 업비트 (키 불필요, 항상 등록)
 * - KR_EQUITY: FSC_API_KEY 필요 (공공데이터포털 활용신청)
 * - US_EQUITY: TWELVEDATA_API_KEY 우선, 없으면 개발 모드에 한해 Stooq
 * 미등록 자산군의 게시·판정은 명시적 에러로 실패한다 (조용한 오동작 방지).
 */
export function createDefaultRegistry(env = process.env): ProviderRegistry {
  const registry: ProviderRegistry = {
    CRYPTO: new UpbitMarketDataProvider(),
  };

  if (env.FSC_API_KEY) {
    registry.KR_EQUITY = new FscMarketDataProvider(env.FSC_API_KEY);
  }

  if (env.TWELVEDATA_API_KEY) {
    registry.US_EQUITY = new TwelveDataMarketDataProvider(env.TWELVEDATA_API_KEY);
  } else if (env.NODE_ENV !== 'production') {
    // Stooq는 개발·검증 전용 — 프로덕션에서는 절대 폴백하지 않는다
    registry.US_EQUITY = new StooqMarketDataProvider();
  }

  return registry;
}
