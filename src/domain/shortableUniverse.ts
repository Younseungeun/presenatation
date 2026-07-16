import type { AssetClass } from './constants';

// 하락(sell) 예측 가능 종목 유니버스.
//
// 근거: 하락 예측 리포트는 구매자가 실제로 따라 할 수단(숏 포지션)이 있어야
// 상품으로 성립한다. 잡주는 인버스 상품 자체가 없어 예측이 맞아도 소비자가
// 수익화할 방법이 없다 → 자산군별로 숏 실행 수단이 존재하는 종목만 허용한다.
// - 국내주식: 개인의 개별 종목 공매도는 사실상 불가(신용대주 제한적) —
//   현실적 수단은 KRX 개별주식선물. 선물 상장 종목만 하락 예측 허용
// - 미국주식: 국내 증권사 해외주식 계좌로는 공매도 불가 —
//   현실적 수단은 인버스 싱글스톡 ETF(-1x/-2x, Direxion·GraniteShares·T-Rex 등).
//   해당 ETF가 존재하는 종목만 하락 예측 허용
// - 코인: 선물·마진으로 어느 종목이든 숏 가능 → 제한 없음
//
// 목록은 초안(운영 확정 필요): KR은 KRX 개별주식선물 상장 종목 전체로,
// US는 인버스 ETF 신규 상장·상폐를 반영해 운영 데이터로 교체한다.
// 상장 폐지·선물 상폐 시 기존 카드는 유지(판정 불가 규칙이 처리), 신규 게시만 막힌다.
//
// 역할: 이 목록은 종목 마스터(Instrument.shortable) 동기화의 "원천 데이터"다.
// 런타임 검증·검색은 전부 종목 마스터 DB를 기준으로 한다 (instrumentService).

export interface ShortableStock {
  ticker: string;
  name: string;
}

const KR_SHORTABLE: ReadonlyArray<ShortableStock> = [
  { ticker: '005930', name: '삼성전자' },
  { ticker: '000660', name: 'SK하이닉스' },
  { ticker: '373220', name: 'LG에너지솔루션' },
  { ticker: '207940', name: '삼성바이오로직스' },
  { ticker: '005380', name: '현대차' },
  { ticker: '000270', name: '기아' },
  { ticker: '068270', name: '셀트리온' },
  { ticker: '005490', name: 'POSCO홀딩스' },
  { ticker: '035420', name: 'NAVER' },
  { ticker: '035720', name: '카카오' },
  { ticker: '051910', name: 'LG화학' },
  { ticker: '006400', name: '삼성SDI' },
  { ticker: '105560', name: 'KB금융' },
  { ticker: '055550', name: '신한지주' },
  { ticker: '086790', name: '하나금융지주' },
  { ticker: '316140', name: '우리금융지주' },
  { ticker: '028260', name: '삼성물산' },
  { ticker: '012330', name: '현대모비스' },
  { ticker: '096770', name: 'SK이노베이션' },
  { ticker: '066570', name: 'LG전자' },
  { ticker: '033780', name: 'KT&G' },
  { ticker: '015760', name: '한국전력' },
  { ticker: '017670', name: 'SK텔레콤' },
  { ticker: '030200', name: 'KT' },
  { ticker: '323410', name: '카카오뱅크' },
  { ticker: '259960', name: '크래프톤' },
  { ticker: '009150', name: '삼성전기' },
  { ticker: '402340', name: 'SK스퀘어' },
  { ticker: '034220', name: 'LG디스플레이' },
  { ticker: '034020', name: '두산에너빌리티' },
  { ticker: '012450', name: '한화에어로스페이스' },
  { ticker: '329180', name: 'HD현대중공업' },
  { ticker: '247540', name: '에코프로비엠' },
  { ticker: '086520', name: '에코프로' },
  { ticker: '196170', name: '알테오젠' },
];

const US_SHORTABLE: ReadonlyArray<ShortableStock> = [
  { ticker: 'TSLA', name: 'Tesla' },
  { ticker: 'NVDA', name: 'NVIDIA' },
  { ticker: 'AAPL', name: 'Apple' },
  { ticker: 'MSFT', name: 'Microsoft' },
  { ticker: 'AMZN', name: 'Amazon' },
  { ticker: 'META', name: 'Meta Platforms' },
  { ticker: 'GOOGL', name: 'Alphabet' },
  { ticker: 'AMD', name: 'AMD' },
  { ticker: 'NFLX', name: 'Netflix' },
  { ticker: 'AVGO', name: 'Broadcom' },
  { ticker: 'MU', name: 'Micron' },
  { ticker: 'INTC', name: 'Intel' },
  { ticker: 'BA', name: 'Boeing' },
  { ticker: 'COIN', name: 'Coinbase' },
  { ticker: 'MSTR', name: 'MicroStrategy' },
  { ticker: 'PLTR', name: 'Palantir' },
  { ticker: 'SMCI', name: 'Super Micro Computer' },
  { ticker: 'ARM', name: 'Arm Holdings' },
  { ticker: 'BABA', name: 'Alibaba' },
  { ticker: 'TSM', name: 'TSMC (ADR)' },
  { ticker: 'QCOM', name: 'Qualcomm' },
  { ticker: 'HOOD', name: 'Robinhood' },
  { ticker: 'MARA', name: 'MARA Holdings' },
  { ticker: 'RIVN', name: 'Rivian' },
  { ticker: 'LLY', name: 'Eli Lilly' },
];

/** 하락 예측 가능 종목 목록 (작성 화면 검색용). 코인은 빈 배열 = 제한 없음 */
export const SHORTABLE_STOCKS: Record<AssetClass, ReadonlyArray<ShortableStock>> = {
  KR_EQUITY: KR_SHORTABLE,
  US_EQUITY: US_SHORTABLE,
  CRYPTO: [],
};

const SHORTABLE_TICKER_SET: Record<AssetClass, ReadonlySet<string>> = {
  KR_EQUITY: new Set(KR_SHORTABLE.map((s) => s.ticker)),
  US_EQUITY: new Set(US_SHORTABLE.map((s) => s.ticker)),
  CRYPTO: new Set(),
};

/** 하락(sell) 예측을 게시할 수 있는 종목인가. 코인은 항상 true */
export function isShortAllowed(assetClass: AssetClass, ticker: string): boolean {
  if (assetClass === 'CRYPTO') return true;
  return SHORTABLE_TICKER_SET[assetClass].has(ticker);
}

/** 하락 예측 제한 안내문 (검증 오류·작성 화면 공용) */
export const SHORT_RESTRICTION_NOTE: Record<Exclude<AssetClass, 'CRYPTO'>, string> = {
  KR_EQUITY:
    '국내주식 하락 예측은 개별주식선물 상장 종목만 가능합니다 — 그 외 종목은 구매자가 숏 포지션을 잡을 수단이 없습니다',
  US_EQUITY:
    '미국주식 하락 예측은 인버스 싱글스톡 ETF가 있는 종목만 가능합니다 — 그 외 종목은 구매자가 숏 포지션을 잡을 수단이 없습니다',
};
