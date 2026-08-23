// 히트맵 표시용 정적 메타 — 종목명 + 섹터 분류 + 대략 시가총액(조 원 단위) 스냅샷.
// 트레이딩뷰 히트맵처럼 "타일 면적 = 시가총액, 섹터별 구획"을 전체 유니버스에 그리기 위한
// 것으로, 실시간 시세가 아니라 공개된 대략값이라 외부 API·비용·재배포 라이선스가 전혀 없다.
// 섹터명·소속은 트레이딩뷰 한국 히트맵 표기를 그대로 따른다.
// 시총 비례는 2026-08 스크린샷 기준 — 삼성전자와 SK하이닉스가 비슷한 크기다.
// 예측 유무와 무관하게 여기 있는 종목은 모두 타일로 그려진다 (예측 없으면 연회색).

export interface HeatmapMeta {
  name: string;
  sector: string;
  /** 대략 시가총액, 조 원 (데모 스냅샷 — 판정·정산 어디에도 쓰지 않는 표시 전용 값) */
  capTrillionKrw: number;
}

const META: Record<string, HeatmapMeta> = {
  // 국내주식 — 전자 기술 (삼성전자·SK하이닉스가 나란히 캔버스 왼쪽을 압도)
  'KR_EQUITY:005930': { name: '삼성전자', sector: '전자 기술', capTrillionKrw: 420 },
  'KR_EQUITY:000660': { name: 'SK하이닉스', sector: '전자 기술', capTrillionKrw: 370 },
  'KR_EQUITY:012450': { name: '한화에어로스페이스', sector: '전자 기술', capTrillionKrw: 35 },
  'KR_EQUITY:009150': { name: '삼성전기', sector: '전자 기술', capTrillionKrw: 15 },
  // 금융 (트레이딩뷰는 SK스퀘어를 금융으로 분류한다)
  'KR_EQUITY:402340': { name: 'SK스퀘어', sector: '금융', capTrillionKrw: 30 },
  'KR_EQUITY:105560': { name: 'KB금융', sector: '금융', capTrillionKrw: 35 },
  'KR_EQUITY:055550': { name: '신한지주', sector: '금융', capTrillionKrw: 25 },
  'KR_EQUITY:032830': { name: '삼성생명', sector: '금융', capTrillionKrw: 20 },
  'KR_EQUITY:086790': { name: '하나금융지주', sector: '금융', capTrillionKrw: 18 },
  'KR_EQUITY:316140': { name: '우리금융지주', sector: '금융', capTrillionKrw: 12 },
  'KR_EQUITY:323410': { name: '카카오뱅크', sector: '금융', capTrillionKrw: 10 },
  // 생산자 제조
  'KR_EQUITY:373220': { name: 'LG에너지솔루션', sector: '생산자 제조', capTrillionKrw: 80 },
  'KR_EQUITY:034020': { name: '두산에너빌리티', sector: '생산자 제조', capTrillionKrw: 30 },
  'KR_EQUITY:329180': { name: 'HD현대중공업', sector: '생산자 제조', capTrillionKrw: 25 },
  'KR_EQUITY:012330': { name: '현대모비스', sector: '생산자 제조', capTrillionKrw: 25 },
  'KR_EQUITY:006400': { name: '삼성SDI', sector: '생산자 제조', capTrillionKrw: 20 },
  // 소비자 내구재
  'KR_EQUITY:005380': { name: '현대차', sector: '소비자 내구재', capTrillionKrw: 55 },
  'KR_EQUITY:000270': { name: '기아', sector: '소비자 내구재', capTrillionKrw: 40 },
  'KR_EQUITY:066570': { name: 'LG전자', sector: '소비자 내구재', capTrillionKrw: 15 },
  // 의료 기술
  'KR_EQUITY:207940': { name: '삼성바이오로직스', sector: '의료 기술', capTrillionKrw: 70 },
  'KR_EQUITY:068270': { name: '셀트리온', sector: '의료 기술', capTrillionKrw: 40 },
  // 기술 서비스
  'KR_EQUITY:035420': { name: 'NAVER', sector: '기술 서비스', capTrillionKrw: 30 },
  'KR_EQUITY:035720': { name: '카카오', sector: '기술 서비스', capTrillionKrw: 18 },
  'KR_EQUITY:259960': { name: '크래프톤', sector: '기술 서비스', capTrillionKrw: 15 },
  // 산업 서비스·공정 산업·비에너지 광물·커뮤니케이션·유틸리티
  'KR_EQUITY:028260': { name: '삼성물산', sector: '산업 서비스', capTrillionKrw: 22 },
  'KR_EQUITY:051910': { name: 'LG화학', sector: '공정 산업', capTrillionKrw: 20 },
  'KR_EQUITY:005490': { name: 'POSCO홀딩스', sector: '비에너지 광물', capTrillionKrw: 22 },
  'KR_EQUITY:017670': { name: 'SK텔레콤', sector: '커뮤니케이션', capTrillionKrw: 12 },
  'KR_EQUITY:030200': { name: 'KT', sector: '커뮤니케이션', capTrillionKrw: 10 },
  'KR_EQUITY:015760': { name: '한국전력', sector: '유틸리티', capTrillionKrw: 15 },

  // 미국주식
  'US_EQUITY:NVDA': { name: 'NVIDIA', sector: '전자 기술', capTrillionKrw: 4200 },
  'US_EQUITY:AAPL': { name: 'Apple', sector: '전자 기술', capTrillionKrw: 4000 },
  'US_EQUITY:AVGO': { name: 'Broadcom', sector: '전자 기술', capTrillionKrw: 1500 },
  'US_EQUITY:AMD': { name: 'AMD', sector: '전자 기술', capTrillionKrw: 350 },
  'US_EQUITY:MSFT': { name: 'Microsoft', sector: '기술 서비스', capTrillionKrw: 3800 },
  'US_EQUITY:GOOGL': { name: 'Alphabet', sector: '기술 서비스', capTrillionKrw: 2600 },
  'US_EQUITY:META': { name: 'Meta', sector: '기술 서비스', capTrillionKrw: 1900 },
  'US_EQUITY:NFLX': { name: 'Netflix', sector: '기술 서비스', capTrillionKrw: 700 },
  'US_EQUITY:AMZN': { name: 'Amazon', sector: '소매업', capTrillionKrw: 2500 },
  'US_EQUITY:TSLA': { name: 'Tesla', sector: '소비자 내구재', capTrillionKrw: 1300 },

  // 코인 (섹터 개념이 없어 통화 성격으로 묶는다)
  'CRYPTO:KRW-BTC': { name: '비트코인', sector: '결제·가치 저장', capTrillionKrw: 2600 },
  'CRYPTO:KRW-ETH': { name: '이더리움', sector: '스마트 컨트랙트', capTrillionKrw: 450 },
  'CRYPTO:KRW-SOL': { name: '솔라나', sector: '스마트 컨트랙트', capTrillionKrw: 100 },
};

// 유니버스는 자산군별 전 종목 스냅샷(src/data/*-heatmap.json)이 담당하고,
// 이 메타는 스냅샷에 없는 티커(상폐 직전 등 경계 사례)의 폴백으로만 쓰인다.
export function heatmapMeta(assetClass: string, ticker: string): HeatmapMeta | undefined {
  return META[`${assetClass}:${ticker}`];
}
