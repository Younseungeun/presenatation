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

/**
 * 국내 마스터의 꼬리 고정폭 구간 — 앞쪽 가변 길이(한글명)를 잘라내는 기준.
 * **파일마다 다르다** (실측: 코스피 228 / 코스닥 222)라서 상수로 박지 않고 탐지한다.
 */
const KR_TAIL_CANDIDATES = { min: 200, max: 260 } as const;

/**
 * 증권그룹구분코드 — 꼬리의 [1:3]에 온다 (실측: scripts/probeKrMaster.ts).
 * 코스피 1,784건 기준 ST 891 · EF 866 · RT 22 · IF 2 · MF 1 · DR 1 · FS 1.
 *
 * **예측 카드의 대상은 기업의 주권이다.** 지수를 그대로 따라가는 ETF와 펀드류는
 * "이 회사가 어떻게 될 것인가"라는 리포트의 대상이 아니고, 특히 레버리지·인버스
 * ETF는 설계상 기초자산의 2~3배로 움직여 안정성 눈금(domain/stability.ts)까지 흔든다.
 * 리츠(RT)와 외국기업 주권·예탁증권(FS·DR)은 개별 기업 분석의 대상이라 남긴다.
 *
 * ETN은 이 두 파일에 아예 없다(EN 0건, 5xx/58x 코드 미수록) — 별도 마스터라
 * 지금 유니버스에는 처음부터 들어오지 않는다.
 */
const TRADABLE_GROUPS = new Set(['ST', 'RT', 'DR', 'FS']);
/** 그룹코드 탐지가 맞았는지 확인하는 기준값 — 이 중 하나가 나와야 꼬리 길이가 맞은 것이다 */
const KNOWN_GROUPS = new Set([...TRADABLE_GROUPS, 'EF', 'EN', 'IF', 'MF', 'SC', 'BC', 'FE']);

/**
 * 관리종목 플래그의 자리 — 꼬리 63번 (실측: scripts/probeMasterFlags.ts, 2026-08-12).
 * API가 주는 값(mang_issu_cls_code)을 정답으로 두고 36종목을 대조해 **완전히 일치하는
 * 유일한 자리**로 확정했다(양성 15, 오탐 0).
 *
 * 이 한 자리 덕분에 위험 정보를 **정적 파일 한 번**으로 전 종목 갱신할 수 있다 —
 * REST로 물어보면 2,684종목 × 1.1초 = 49분이다.
 * (거래정지·시장경고는 같은 방법으로 확정하지 못했다. 표본에 거래정지 종목이 없었고
 *  시장경고는 양성이 1건뿐이라 우연 일치와 구별되지 않는다 — 그 둘은 카드가 걸린
 *  종목에 한해 현재가 응답에서 받는다(kisProvider.getRiskSignal).)
 */
const KR_MANAGED_ISSUE_IDX = 63;

/** 미국 마스터 증권종류 — 3이 ETF·ETP (실측). 2가 주식 */
const US_ETF_SECURITY_TYPE = '3';

/**
 * 꼬리 길이 탐지 — 그룹코드가 [1:3]에 오는 길이를 찾는다.
 * 규격이 바뀌면 상수는 조용히 어긋나지만(엉뚱한 자리를 그룹코드로 읽는다),
 * 탐지는 "아무 길이에서도 안 맞는다"로 드러난다.
 */
function detectTailLen(lines: string[]): number | null {
  const sample = lines.filter((l) => /^\d{6}$/.test(l.slice(0, 9).trim())).slice(0, 400);
  if (sample.length === 0) return null;
  let best: { len: number; hits: number } = { len: 0, hits: 0 };
  for (let len = KR_TAIL_CANDIDATES.min; len <= KR_TAIL_CANDIDATES.max; len++) {
    let hits = 0;
    for (const l of sample) {
      if (l.length <= len) continue;
      if (KNOWN_GROUPS.has(l.slice(l.length - len).slice(1, 3))) hits++;
    }
    if (hits > best.hits) best = { len, hits };
  }
  // 표본의 9할이 맞아야 인정한다 — 우연히 몇 줄 맞는 길이를 고르지 않게
  return best.hits >= sample.length * 0.9 ? best.len : null;
}

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
 * 국내 상장 종목 — **기업의 주권만** 남긴다.
 *
 * 두 겹으로 거른다:
 *  ① 6자리 숫자 코드 — 마스터에는 펀드(F로 시작)·ELW 등이 섞여 있다
 *  ② 증권그룹구분코드 — ETF(EF 866건)·인프라펀드가 ①을 통과하므로 여기서 뺀다
 * 꼬리 길이를 못 찾으면(규격 변경) **그 파일을 통째로 건너뛴다** — 엉뚱한 자리를
 * 그룹코드로 읽어 멀쩡한 종목을 지우거나 ETF를 들이는 것보다, 목록이 줄어 눈에
 * 띄는 편이 낫다.
 */
export async function fetchKrInstruments(): Promise<InstrumentListing[]> {
  const out = new Map<string, InstrumentListing>();
  for (const file of KR_FILES) {
    const lines = await download(file);
    const tailLen = detectTailLen(lines);
    if (tailLen === null) {
      console.error(`[kis-master] ${file}: 증권그룹구분코드 위치를 찾지 못해 건너뜁니다`);
      continue;
    }
    for (const line of lines) {
      const ticker = line.slice(0, 9).trim();
      if (!/^\d{6}$/.test(ticker)) continue;
      const tail = line.slice(line.length - tailLen);
      if (!TRADABLE_GROUPS.has(tail.slice(1, 3))) continue;
      const name = line.slice(21, Math.max(21, line.length - tailLen)).trim();
      if (!name) continue;
      // 관리종목은 상장폐지 심사 대상이라 경고와 같은 무게로 다룬다 (domain/instrumentRisk.ts)
      const managed = tail[KR_MANAGED_ISSUE_IDX] === 'Y';
      out.set(ticker, {
        ticker,
        name,
        currency: 'KRW',
        ...(managed ? { risk: { warning: true, note: '관리종목' } } : {}),
      });
    }
  }
  return [...out.values()];
}

/**
 * 미국 상장 종목 (나스닥·뉴욕·아멕스).
 * 탭 구분이고 쓰는 칸은 심볼(4)·한글명(6)·영문명(7)·증권종류(8)·통화(9)다.
 * 한글명이 있으면 그쪽을 쓴다 — 화면이 한국어라 "엔비디아"가 "NVIDIA CORP"보다 읽힌다.
 *
 * **증권종류 칸(8)으로 ETF를 뺀다** (실측 2026-08-12: 2=주식 3,948 / 3=ETF·ETP 1,289.
 * QQQ·TQQQ·SQQQ가 3, AAPL·NVDA·TSLA가 2). 국내만 걸러 두고 미국은 ETF가 그대로
 * 들어와 있었다 — 예측 대상은 기업의 주권이라는 같은 기준을 두 시장에 적용한다.
 * (칸 17의 Y/N은 거래정지가 아니라 **ADR 여부**였다 — CRESY·AZN·BP 등 예탁증권만 Y다.
 *  미국 마스터에는 거래정지·상장폐지 정보가 없다.)
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
      if ((f[8] ?? '').trim() === US_ETF_SECURITY_TYPE) continue;
      out.set(ticker, { ticker, name, currency: (f[9] ?? 'USD').trim() || 'USD' });
    }
  }
  return [...out.values()];
}
