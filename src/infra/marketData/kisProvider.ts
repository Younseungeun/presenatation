import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DailyQuote,
  InstrumentListing,
  MarketDataProvider,
  SecurityStatus,
} from '@/domain/marketData';
import type { ProviderRiskSignal } from '@/domain/instrumentRisk';
import { fetchKrInstruments, fetchUsInstruments } from './kisInstrumentMaster';

// 한국투자증권 KIS Open API — 국내주식 + 미국주식을 **한 공급자**가 담당한다.
// https://apiportal.koreainvestment.com
//
// 이 소스를 고른 이유:
//  · 국내는 실시간 현재가를 준다 (공공데이터포털 금융위 시세는 D+1 지연이라 장중 보호가 불가능했다)
//  · 미국은 **0분 지연 실시간을 별도 신청 없이 무료** 제공한다 (공식 문서 [해외주식-009]).
//    무료 시세는 나스닥 마켓센터 체결분이라 유료 대비 평균 50% 수준이지만, 우리가 장중에
//    보는 것은 "목표까지 남은 폭이 구간 바닥의 절반 밑인가"라는 넓은 띠라 결론이 바뀌지 않는다.
//  · 확정 마감·판정은 어차피 **일봉 종가**로 하므로 체결가 몇 틱 차이는 그쪽에도 영향이 없다
//
// ── 운영 제약 두 가지 (실측) ──────────────────────────────────
// ① **접근토큰 24시간, 발급은 분당 1회** — 메모리 캐시만으로는 부족하다.
//    배치(batch:judge / batch:salesclose / batch:earlyjudge)는 **각각 별도 프로세스**라
//    메모리가 공유되지 않아, 연달아 돌리면 두 번째부터 전부 403으로 죽는다.
//    그래서 토큰을 **파일에 남겨 프로세스 사이에서 재사용**한다.
// ② **초당 호출 제한** — 연속 호출은 절반이 `초당 거래건수를 초과하였습니다`로 떨어진다.
//    실측: 0ms 5/10, 300ms 7/10, 600ms 7/10, **1100ms 10/10**.
//    그래서 호출을 직렬화하고 최소 간격을 강제한다. 종목 70개면 70초 — 하루 한 번 도는
//    배치에는 문제가 없고, 결제 관문은 60초 캐시(server/priceCache)가 있어 무관하다.

const REAL_BASE = 'https://openapi.koreainvestment.com:9443';
const MOCK_BASE = 'https://openapivts.koreainvestment.com:29443';

/** 실측으로 정한 최소 호출 간격 — 1000ms에서는 간헐적으로 밀려 여유를 뒀다 */
const MIN_CALL_GAP_MS = 1_100;

/** 토큰 만료 여유 — 경계에서 만료된 토큰을 쓰지 않도록 일찍 갱신한다 */
const TOKEN_SAFETY_MS = 10 * 60_000;

/**
 * 미국 거래소 코드. KIS는 종목이 어느 거래소에 있는지를 인자로 받는데,
 * 우리 종목 마스터는 심볼만 들고 있다. 나스닥·뉴욕·아멕스를 차례로 시도한다
 * (첫 조회에서 맞은 거래소를 기억해 두 번째부터는 한 번에 맞춘다).
 */
const US_EXCHANGES = ['NAS', 'NYS', 'AMS'] as const;

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error_description?: string;
  msg1?: string;
}

interface KisEnvelope<T> {
  rt_cd?: string;
  msg1?: string;
  output?: T;
  output1?: T;
  output2?: T;
}

type PriceOutput = Record<string, string>;

/**
 * 국내 현재가(FHKST01010100) 응답 중 **종목상태 필드** — 실측으로 확인한 이름들이다
 * (scripts/probeKisStatus.ts). 시세와 같은 응답에 실려 오므로 추가 호출이 없다.
 */
interface KrStatusOutput extends PriceOutput {
  /** 거래정지 Y/N */
  temp_stop_yn: string;
  /** 정리매매 Y/N — 상장폐지 확정 후 마지막 거래 기간 */
  sltr_yn: string;
  /** 관리종목 Y/N */
  mang_issu_cls_code: string;
  /** 시장경보 00 없음 / 01 투자주의 / 02 투자경고 / 03 투자위험 */
  mrkt_warn_cls_code: string;
  /** 투자유의 Y/N */
  invt_caful_yn: string;
}

export class KisMarketDataProvider implements MarketDataProvider {
  readonly sourceId: string;
  private readonly base: string;
  /**
   * 토큰과 호출 큐는 **앱키 단위로 공유한다.**
   * 국내·미국 인스턴스를 따로 두는데, KIS의 제한은 인스턴스가 아니라 **계정 기준**이다:
   *  · 토큰 발급은 분당 1회 — 인스턴스마다 발급하면 두 번째가 막힌다
   *  · 초당 호출 제한도 계정 합산 — 큐가 분리되면 서로 모르고 겹쳐 나간다
   */
  private readonly shared: SharedGate;
  /** 미국 종목이 실제로 있던 거래소 — 두 번째 조회부터 탐색을 건너뛴다 */
  private readonly exchangeHint = new Map<string, string>();

  constructor(
    private readonly appKey: string,
    private readonly appSecret: string,
    /** 국내(J) / 미국 — 한 인스턴스가 한 자산군을 담당한다 */
    private readonly market: 'KR' | 'US',
    /** 모의투자 도메인 사용 여부 — 시세가 실제와 다르므로 개발 확인용으로만 */
    mock = false,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = mock ? MOCK_BASE : REAL_BASE;
    this.sourceId = `kis-${market.toLowerCase()}${mock ? '-mock' : ''}`;
    this.shared = sharedGate(appKey);
  }

  // ── 호출 관문 ────────────────────────────────────────────────

  /** 초당 제한을 지키며 순서대로 실행한다 */
  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const g = this.shared;
    const run = g.queue.then(async () => {
      const wait = g.lastCallAt + MIN_CALL_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      g.lastCallAt = Date.now();
      return fn();
    });
    // 실패가 뒤 호출을 막지 않도록 큐 자체는 항상 이어 간다
    g.queue = run.catch(() => undefined);
    return run;
  }

  private async accessToken(): Promise<string> {
    const g = this.shared;
    if (g.token && g.token.expiresAt > Date.now()) return g.token.value;
    // 프로세스가 새로 떴으면 파일에서 되살린다 (배치는 실행마다 새 프로세스다)
    const cached = readTokenFile(this.appKey);
    if (cached && cached.expiresAt > Date.now()) {
      g.token = cached;
      return cached.value;
    }
    // 동시에 여러 호출이 토큰을 요청하면 발급이 두 번 나간다 — 진행 중인 요청을 공유한다
    if (g.issuing) return g.issuing;
    g.issuing = this.issueToken().finally(() => { g.issuing = null; });
    return g.issuing;
  }

  private async issueToken(): Promise<string> {
    const g = this.shared;
    const res = await this.fetchImpl(`${this.base}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        appkey: this.appKey,
        appsecret: this.appSecret,
      }),
    });
    const body = (await res.json()) as TokenResponse;
    if (!body.access_token) {
      throw new Error(
        `KIS 토큰 발급 실패 (HTTP ${res.status}): ${body.error_description ?? body.msg1 ?? '알 수 없는 오류'}`,
      );
    }
    g.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, (body.expires_in ?? 0) * 1000 - TOKEN_SAFETY_MS),
    };
    writeTokenFile(this.appKey, g.token);
    return g.token.value;
  }

  private async call<T>(path: string, trId: string): Promise<KisEnvelope<T>> {
    return this.schedule(async () => {
      const token = await this.accessToken();
      const res = await this.fetchImpl(`${this.base}${path}`, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
          appkey: this.appKey,
          appsecret: this.appSecret,
          tr_id: trId,
          custtype: 'P',
        },
      });
      const body = (await res.json()) as KisEnvelope<T>;
      // rt_cd '0'만 정상. 그 외는 메시지를 그대로 올려 원인이 드러나게 한다
      if (body.rt_cd !== '0') {
        throw new Error(`KIS ${trId} 실패 (HTTP ${res.status}, rt_cd=${body.rt_cd}): ${body.msg1 ?? ''}`);
      }
      return body;
    });
  }

  // ── 일별 시세 ────────────────────────────────────────────────

  async getDailyQuotes(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    const rows =
      this.market === 'KR'
        ? await this.krDaily(ticker, from, to)
        : await this.usDaily(ticker, from, to);
    // 공급자가 최신순으로 주는 경우가 있어 항상 오름차순으로 맞춘다 —
    // 판정·마감 로직이 "구간의 마지막"을 종가로 보기 때문에 순서가 곧 정확성이다
    return rows
      .filter((q) => q.date >= from && q.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** 국내주식 기간별시세 (일봉) — [국내주식-010] */
  private async krDaily(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    const params = new URLSearchParams({
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: ticker,
      FID_INPUT_DATE_1: from.replaceAll('-', ''),
      FID_INPUT_DATE_2: to.replaceAll('-', ''),
      FID_PERIOD_DIV_CODE: 'D',
      FID_ORG_ADJ_PRC: '0', // 수정주가 반영 — 액면분할 전후 시세가 이어지게
    });
    const body = await this.call<PriceOutput[]>(
      `/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?${params}`,
      'FHKST03010100',
    );
    const rows = (body.output2 ?? []) as unknown as PriceOutput[];
    return rows.filter((r) => r.stck_bsop_date).map((r) => ({
      date: isoDate(r.stck_bsop_date),
      open: Number(r.stck_oprc),
      high: Number(r.stck_hgpr),
      low: Number(r.stck_lwpr),
      close: Number(r.stck_clpr),
      volume: Number(r.acml_vol ?? 0),
    }));
  }

  /** 해외주식 기간별시세 — [해외주식-010] */
  private async usDaily(ticker: string, from: string, to: string): Promise<DailyQuote[]> {
    let lastError: Error | null = null;
    for (const excd of this.exchangeOrder(ticker)) {
      const params = new URLSearchParams({
        AUTH: '',
        EXCD: excd,
        SYMB: ticker,
        GUBN: '0', // 0=일
        BYMD: to.replaceAll('-', ''),
        MODP: '1', // 수정주가 반영
      });
      try {
        const body = await this.call<PriceOutput[]>(
          `/uapi/overseas-price/v1/quotations/dailyprice?${params}`,
          'HHDFS76240000',
        );
        const rows = (body.output2 ?? []) as unknown as PriceOutput[];
        if (rows.length > 0) {
          this.exchangeHint.set(ticker, excd);
          return rows.filter((r) => r.xymd).map((r) => ({
            date: isoDate(r.xymd),
            open: Number(r.open),
            high: Number(r.high),
            low: Number(r.low),
            close: Number(r.clos),
            volume: Number(r.tvol ?? 0),
          }));
        }
      } catch (e) {
        lastError = e as Error;
      }
    }
    // **에러를 삼키지 않는다.** 통째로 삼키면 "이 거래소에 없는 종목"과 "토큰 발급 실패"가
    // 구별되지 않아, 인증이 깨졌는데 "종목 없음"으로 조용히 넘어간다 (실제로 겪었다)
    if (lastError) throw lastError;
    return [];
  }

  // ── 현재가 (장중 보호용) ─────────────────────────────────────

  async getCurrentPrice(ticker: string): Promise<number> {
    if (this.market === 'KR') {
      const params = new URLSearchParams({
        FID_COND_MRKT_DIV_CODE: 'J',
        FID_INPUT_ISCD: ticker,
      });
      const body = await this.call<PriceOutput>(
        `/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
        'FHKST01010100',
      );
      const price = Number(body.output?.stck_prpr);
      if (!Number.isFinite(price) || price <= 0) throw new Error(`KIS 현재가 없음: ${ticker}`);
      return price;
    }

    let lastError: Error | null = null;
    for (const excd of this.exchangeOrder(ticker)) {
      const params = new URLSearchParams({ AUTH: '', EXCD: excd, SYMB: ticker });
      try {
        const body = await this.call<PriceOutput>(
          `/uapi/overseas-price/v1/quotations/price?${params}`,
          'HHDFS00000300',
        );
        const price = Number(body.output?.last);
        if (Number.isFinite(price) && price > 0) {
          this.exchangeHint.set(ticker, excd);
          return price;
        }
      } catch (e) {
        lastError = e as Error;
      }
    }
    if (lastError) throw lastError;
    throw new Error(`KIS 현재가 없음: ${ticker}`);
  }

  /**
   * 종목 상태 — 국내는 **현재가 응답이 그대로 답을 들고 있다** (2026-08-12 실측).
   *
   * 예전 주석은 "KIS는 거래정지·상장폐지를 주지 않는다"였는데 사실이 아니었다.
   * 이미 장중 보호용으로 부르는 `inquire-price`(FHKST01010100) 응답에 상태 필드가
   * 함께 온다 — 별도 엔드포인트도, 추가 호출 한도도 필요 없다:
   *   temp_stop_yn        거래정지
   *   sltr_yn             정리매매 (상장폐지 확정 후 마지막 거래 기간)
   *   mang_issu_cls_code  관리종목
   *   mrkt_warn_cls_code  시장경보 00 없음 / 01 주의 / 02 경고 / 03 위험
   *   invt_caful_yn       투자유의
   * (상품기본조회 계열 TR은 같은 토큰으로 "유효하지 않은 token"을 돌려준다 — 권한이
   *  다른 것으로 보이나, 필요한 값이 여기 다 있으므로 파고들지 않았다.)
   *
   * delisted는 **정리매매를 상장폐지 진행으로 본다** — 실제로 폐지되면 종목이
   * 마스터에서 사라져 시세 자체가 비므로, 판정이 판단해야 하는 시점은 그 직전이다.
   *
   * 미국은 이 필드가 없어 예전 동작(정상 반환)을 유지한다. 상폐·정지 종목은 시세가
   * 비어 오고, 판정 파이프라인이 데이터 결측으로 이월시킨 뒤 운영자 큐로 올린다.
   */
  async getSecurityStatus(ticker: string): Promise<SecurityStatus> {
    if (this.market !== 'KR') return { delisted: false, halted: false };

    const params = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker });
    const body = await this.call<KrStatusOutput>(
      `/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
      'FHKST01010100',
    );
    const out = body.output;
    // 응답이 비면 "정상"이라고 단정하지 않는다 — 판정 파이프라인이 결측으로 다루게 둔다
    if (!out) throw new Error(`KIS 종목상태 없음: ${ticker}`);
    return {
      delisted: out.sltr_yn === 'Y',
      halted: out.temp_stop_yn === 'Y',
    };
  }

  /**
   * 시장경보·관리종목 — 종목 마스터의 위험 등급(Instrument.riskLevel) 갱신용.
   * getSecurityStatus와 같은 응답에서 나오지만 쓰는 곳이 달라 따로 낸다
   * (상태는 판정이, 위험은 게시 가능 여부가 쓴다).
   */
  async getRiskSignal(ticker: string): Promise<ProviderRiskSignal> {
    if (this.market !== 'KR') return {};

    const params = new URLSearchParams({ FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: ticker });
    const body = await this.call<KrStatusOutput>(
      `/uapi/domestic-stock/v1/quotations/inquire-price?${params}`,
      'FHKST01010100',
    );
    const out = body.output;
    if (!out) return {};

    const warn = out.mrkt_warn_cls_code ?? '00';
    const managed = out.mang_issu_cls_code === 'Y';
    const notes = [
      warn === '01' ? '투자주의' : warn === '02' ? '투자경고' : warn === '03' ? '투자위험' : null,
      managed ? '관리종목' : null,
      out.invt_caful_yn === 'Y' ? '투자유의' : null,
      out.sltr_yn === 'Y' ? '정리매매' : null,
    ].filter(Boolean);

    return {
      // 정리매매는 상장폐지가 확정된 상태다
      delisting: out.sltr_yn === 'Y' || warn === '03',
      // 관리종목은 상폐 심사 대상이라 경고와 같은 무게로 다룬다
      warning: warn === '02' || managed,
      caution: warn === '01' || out.invt_caful_yn === 'Y',
      note: notes.length > 0 ? notes.join(' · ') : undefined,
    };
  }

  /**
   * 상장 종목 전체 — 종목 마스터(Instrument) 동기화용.
   * **REST가 아니라 정적 마스터 파일**에서 읽는다(kisInstrumentMaster.ts): 인증도
   * 호출 제한도 없고 파일 하나에 전 종목이 들어 있다. 그래서 이 메서드만 호출 큐를
   * 타지 않는다 — 시세 조회와 성격이 다른 일이다.
   */
  listInstruments(): Promise<InstrumentListing[]> {
    return this.market === 'KR' ? fetchKrInstruments() : fetchUsInstruments();
  }

  private exchangeOrder(ticker: string): readonly string[] {
    const hint = this.exchangeHint.get(ticker);
    return hint ? [hint, ...US_EXCHANGES.filter((e) => e !== hint)] : US_EXCHANGES;
  }
}

// ── 토큰 파일 캐시 ───────────────────────────────────────────
//
// 위치는 OS 임시 폴더 — 저장소에 남기지 않는다(토큰은 24시간짜리 비밀이다).
// 파일명에 앱키 해시를 넣어 계정이 바뀌면 자동으로 다른 파일이 된다.
//
// **한계**: 서버를 여러 대로 늘리면 대수만큼 발급이 나가 분당 1회에 걸린다.
// 그때는 이 자리를 공용 저장소(DB·Redis)로 바꿔야 한다 — 지금은 단일 인스턴스 전제.
function tokenFilePath(appKey: string): string {
  let h = 0;
  for (let i = 0; i < appKey.length; i++) h = (h * 31 + appKey.charCodeAt(i)) | 0;
  return path.join(os.tmpdir(), `kis-token-${(h >>> 0).toString(36)}.json`);
}

function readTokenFile(appKey: string): { value: string; expiresAt: number } | null {
  try {
    const raw = fs.readFileSync(tokenFilePath(appKey), 'utf8');
    const t = JSON.parse(raw) as { value: string; expiresAt: number };
    return typeof t.value === 'string' && typeof t.expiresAt === 'number' ? t : null;
  } catch {
    return null;
  }
}

function writeTokenFile(appKey: string, token: { value: string; expiresAt: number }): void {
  try {
    fs.writeFileSync(tokenFilePath(appKey), JSON.stringify(token), { mode: 0o600 });
  } catch {
    // 파일을 못 써도 동작은 한다 — 메모리 캐시로 이 프로세스 안에서는 재사용된다
  }
}

interface SharedGate {
  token: { value: string; expiresAt: number } | null;
  issuing: Promise<string> | null;
  lastCallAt: number;
  queue: Promise<unknown>;
}

/** 앱키 하나당 게이트 하나 — 같은 계정의 모든 인스턴스가 토큰과 호출 간격을 나눠 쓴다 */
const GATES = new Map<string, SharedGate>();
function sharedGate(appKey: string): SharedGate {
  let g = GATES.get(appKey);
  if (!g) {
    g = { token: null, issuing: null, lastCallAt: 0, queue: Promise.resolve() };
    GATES.set(appKey, g);
  }
  return g;
}

/** KIS는 YYYYMMDD로 준다 */
function isoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}
