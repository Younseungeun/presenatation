import type { ProviderRiskSignal } from '@/domain/instrumentRisk';

// Nasdaq Trader 공개 파일 — **미국 종목의 상장 상태·ETF 여부·거래정지의 무료 출처.**
//
// 왜 필요한가: KIS 미국 마스터에는 거래정지·상장폐지 정보가 없다(실측 2026-08-12 —
// 이진 칸으로 보이던 것은 ADR 표시였다). 그래서 국내와 달리 미국 카드는 "시세가 안
// 오면 이월"이 유일한 방어였다.
//
// 나스닥이 직접 게시하는 파일들은 인증도 요율 제한도 없고 매일 갱신된다:
//   · SymDir/nasdaqlisted.txt  나스닥 상장 — ETF 여부 + **Financial Status**
//   · SymDir/otherlisted.txt   NYSE·AMEX 등 — ETF 여부
//   · rss.aspx?feed=tradehalts 현재 거래정지 (당일 발생분)
//
// Financial Status 분포 (실측): N 5,257 정상 / D 315 요건미달 / E 11 공시지연 / H 5 둘 다.
// D·E·H·Q는 상장폐지 심사로 이어지는 상태라 위험 등급의 근거가 된다.

const SYM_DIR = 'https://www.nasdaqtrader.com/dynamic/SymDir';
const HALTS_FEED = 'https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts';

export interface UsListing {
  /** KIS 표기로 정규화한 심볼 (BRK.B·BRK-B → BRK/B) */
  ticker: string;
  name: string;
  /** ETF·ETN 등 상장지수상품 */
  etf: boolean;
  /** 시험 목적 종목 — 실제 거래 대상이 아니다 */
  testIssue: boolean;
  /**
   * 나스닥 재무 상태: N 정상 / D 요건미달 / E 공시지연 / Q 파산 /
   * G·H·J·K 복합. 나스닥 외 거래소(otherlisted)는 제공하지 않아 null.
   */
  financialStatus: string | null;
}

/**
 * 심볼 표기 정규화 — 나스닥은 우선주·클래스를 `.`(ACT)나 `-`(NASDAQ)로 쓰고
 * KIS 마스터는 `/`를 쓴다 (BRK.B / BRK-B / BRK/B가 같은 종목이다).
 */
export function normalizeUsSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[.\-]/g, '/');
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nasdaq Trader 파일 다운로드 실패 (${url}): HTTP ${res.status}`);
  return res.text();
}

/** 파이프 구분 텍스트 — 첫 줄 헤더, 마지막 줄은 "File Creation Time" 꼬리표라 버린다 */
function parsePipe(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].split('|').map((h) => h.trim());
  return lines
    .slice(1)
    .filter((l) => !l.startsWith('File Creation Time'))
    .map((l) => {
      const cells = l.split('|');
      return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? '').trim()]));
    });
}

/** 나스닥 + 그 외 거래소 상장 목록 (심볼 기준으로 합친다) */
export async function fetchUsListings(): Promise<UsListing[]> {
  const [nasdaq, other] = await Promise.all([
    fetchText(`${SYM_DIR}/nasdaqlisted.txt`).then(parsePipe),
    fetchText(`${SYM_DIR}/otherlisted.txt`).then(parsePipe),
  ]);

  const out = new Map<string, UsListing>();
  for (const r of nasdaq) {
    const ticker = normalizeUsSymbol(r['Symbol'] ?? '');
    if (!ticker) continue;
    out.set(ticker, {
      ticker,
      name: r['Security Name'] ?? '',
      etf: r['ETF'] === 'Y',
      testIssue: r['Test Issue'] === 'Y',
      financialStatus: r['Financial Status'] || null,
    });
  }
  for (const r of other) {
    const ticker = normalizeUsSymbol(r['ACT Symbol'] ?? '');
    if (!ticker || out.has(ticker)) continue;
    out.set(ticker, {
      ticker,
      name: r['Security Name'] ?? '',
      etf: r['ETF'] === 'Y',
      testIssue: r['Test Issue'] === 'Y',
      financialStatus: null, // 나스닥 외 거래소는 재무 상태를 주지 않는다
    });
  }
  return [...out.values()];
}

/**
 * 재무 상태 → 위험 신호.
 * D(요건미달)는 상장폐지 심사의 시작이고, Q(파산)·복합 코드는 그보다 무겁다.
 */
export function financialStatusRisk(status: string | null): ProviderRiskSignal | null {
  if (!status || status === 'N') return null;
  const s = status.toUpperCase();
  const bankrupt = s.includes('Q') || s.includes('G') || s.includes('J') || s.includes('K');
  const deficient = s.includes('D') || s.includes('H') || s.includes('K') || s.includes('G');
  const delinquent = s.includes('E') || s.includes('H') || s.includes('J') || s.includes('K');
  const note = [
    bankrupt ? '파산 절차' : null,
    deficient ? '상장요건 미달' : null,
    delinquent ? '공시 지연' : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    delisting: bankrupt,
    warning: deficient,
    caution: delinquent && !deficient && !bankrupt,
    note: note || `재무상태 ${s}`,
  };
}

/**
 * 거래정지 목록의 짧은 캐시 — 판정 배치가 카드마다 물어보므로 한 회차에 한 번만 받는다.
 * 이 파일은 요율 제한이 없지만, 카드 수만큼 같은 파일을 받는 것은 그냥 낭비다.
 */
const HALT_TTL_MS = 5 * 60_000;
let haltCache: { at: number; halted: Set<string> } | null = null;

/** 지금 거래정지 중인가 (재개 공지가 없는 건만). 조회 실패는 "모른다"라 false */
export async function isUsHalted(ticker: string): Promise<boolean> {
  if (!haltCache || Date.now() - haltCache.at >= HALT_TTL_MS) {
    try {
      const halts = await fetchUsHalts();
      haltCache = {
        at: Date.now(),
        halted: new Set(halts.filter((h) => !h.resumptionDate).map((h) => h.ticker)),
      };
    } catch {
      // 피드 장애로 "정지"라고 단정하지 않는다 — 판정은 시세 결측으로 이월된다
      return false;
    }
  }
  return haltCache.halted.has(normalizeUsSymbol(ticker));
}

export interface UsHalt {
  ticker: string;
  reasonCode: string;
  /** 재개가 공지됐으면 그 날짜 (없으면 아직 정지 중) */
  resumptionDate: string | null;
}

/**
 * 오늘의 거래정지 — 재개 공지가 없는 건만 "정지 중"으로 본다.
 * XML을 정규식으로 읽는다: 항목이 평평하고 태그가 고정이라 파서를 들일 이유가 없다.
 */
export async function fetchUsHalts(): Promise<UsHalt[]> {
  const xml = await fetchText(HALTS_FEED);
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  const pick = (block: string, tag: string) =>
    block.match(new RegExp(`<ndaq:${tag}>([^<]*)</ndaq:${tag}>`))?.[1]?.trim() ?? '';

  const out: UsHalt[] = [];
  for (const block of items) {
    const ticker = normalizeUsSymbol(pick(block, 'IssueSymbol'));
    if (!ticker) continue;
    const resumption = pick(block, 'ResumptionDate');
    out.push({
      ticker,
      reasonCode: pick(block, 'ReasonCode'),
      resumptionDate: resumption || null,
    });
  }
  return out;
}
