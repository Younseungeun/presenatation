import AdmZip from 'adm-zip';
import type { InstrumentListing } from '@/domain/marketData';

// KIS 종목정보 마스터 파일 — **전 종목 목록**의 출처.
//
// 시세·종목상태는 카드가 걸린 종목만 있으면 되지만, **목록은 전수여야 한다**:
// 리서처가 카드를 쓸 때 여기 있는 종목만 고를 수 있기 때문이다(자유 입력 금지).
// 목록에 없으면 그 종목으로는 예측 자체를 못 한다.
//
// 이 파일들은 **인증이 필요 없고 호출 제한과도 무관하다** — 정적 다운로드라
// 코스피 전체를 받아도 요청 한 번이다. REST로 종목을 하나씩 물어보는 것과
// 성격이 완전히 다르므로 KIS 시세 어댑터의 호출 큐를 타지 않는다.
//
// 인코딩은 EUC-KR, 국내는 고정폭·해외는 탭 구분이다.

const BASE = 'https://new.real.download.dws.co.kr/common/master';

/** 국내는 코스피·코스닥만 — 코넥스는 유동성이 극히 낮아 예측·판정 대상으로 부적절하다 */
const KR_FILES = ['kospi_code.mst.zip', 'kosdaq_code.mst.zip'];
/** 미국 3대 거래소 */
const US_FILES = ['nasmst.cod.zip', 'nysmst.cod.zip', 'amsmst.cod.zip'];

/** 국내 마스터의 꼬리 고정폭 구간 — 앞쪽 가변 길이(한글명)를 잘라내는 기준 */
const KR_TAIL_LEN = 228;

async function download(file: string): Promise<string[]> {
  const res = await fetch(`${BASE}/${file}`);
  if (!res.ok) throw new Error(`KIS 마스터 파일 다운로드 실패 ${file}: HTTP ${res.status}`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const entry = zip.getEntries()[0];
  if (!entry) throw new Error(`KIS 마스터 파일이 비어 있습니다: ${file}`);
  return new TextDecoder('euc-kr')
    .decode(entry.getData())
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
}

/**
 * 국내 상장 종목.
 *
 * **6자리 숫자 코드만 남긴다** — 마스터에는 펀드(F로 시작)·ELW 등이 함께 들어 있는데
 * 예측 카드의 대상이 아니다. ETF·ETN은 6자리라 이 필터를 통과하는데, 정확히 거르려면
 * 꼬리 구간의 증권그룹구분코드를 읽어야 한다(헤더 규격 확인 필요) — 남은 과제.
 */
export async function fetchKrInstruments(): Promise<InstrumentListing[]> {
  const out = new Map<string, InstrumentListing>();
  for (const file of KR_FILES) {
    for (const line of await download(file)) {
      const ticker = line.slice(0, 9).trim();
      if (!/^\d{6}$/.test(ticker)) continue;
      const name = line.slice(21, Math.max(21, line.length - KR_TAIL_LEN)).trim();
      if (name) out.set(ticker, { ticker, name, currency: 'KRW' });
    }
  }
  return [...out.values()];
}

/**
 * 미국 상장 종목 (나스닥·뉴욕·아멕스).
 * 탭 구분이고 쓰는 칸은 심볼(4)·한글명(6)·영문명(7)·통화(9)다.
 * 한글명이 있으면 그쪽을 쓴다 — 화면이 한국어라 "엔비디아"가 "NVIDIA CORP"보다 읽힌다.
 */
export async function fetchUsInstruments(): Promise<InstrumentListing[]> {
  const out = new Map<string, InstrumentListing>();
  for (const file of US_FILES) {
    let lines: string[];
    try {
      lines = await download(file);
    } catch {
      continue; // 거래소 파일 하나가 막혀도 나머지는 살린다
    }
    for (const line of lines) {
      const f = line.split('\t');
      const ticker = (f[4] ?? '').trim();
      const name = ((f[6] ?? '').trim() || (f[7] ?? '').trim());
      if (!ticker || !name) continue;
      out.set(ticker, { ticker, name, currency: (f[9] ?? 'USD').trim() || 'USD' });
    }
  }
  return [...out.values()];
}
