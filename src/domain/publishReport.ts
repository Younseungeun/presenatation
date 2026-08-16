import {
  TIER_NAME,
  type AssetClass,
  type BaseMode,
  type Direction,
  type PrepaymentRatio,
  type TargetType,
  type Tier,
} from './constants';
import { calcFeeRateBp } from './fees';
import { holidayName } from './marketCalendar';
import { marketClock } from './marketData';
import {
  CONFIDENCE_RANGE,
  disciplineFor,
  minMagnitudePct,
  targetPriceToMagnitudePct,
} from './scoring';

// 리포트 게시 검증 규칙 (순수 로직).
// 게시는 되돌릴 수 없는 행위다: 수수료·선결제 비율·기준가가 고정되고 예측 카드가 잠긴다.
// 여기서 걸러지지 않으면 판정·정산까지 오염되므로 검증은 게시 시점에 전부 끝낸다.

/** 플랫폼 가격 가이드 (CLAUDE.md 3.4절: 건당 5천~5만원) */
/** @근거 설계 기획 §3.4의 가격 가이드 — 건당 5천~5만원 */
export const PRICE_GUIDE_KRW = { min: 5_000, max: 50_000 } as const;

/**
 * 리포트 본문·요약·제목 글자 수 상한 (확정).
 *
 * 목적 두 가지:
 *  ① 컴플라이언스 AI 검수의 입력 토큰 상한을 구조적으로 고정 — 본문이 길어질수록
 *     검수 비용이 선형으로 늘어나므로, 상한이 없으면 비용이 예측 불가능해진다
 *  ② 리포트 품질 — 예측 카드가 결론을 담으므로 본문은 근거를 압축해 쓰는 것이 맞다
 *
 * 요약도 함께 제한한다: 요약은 구매 전 공개되는 미리보기이고, 검수 입력에도
 * 포함되므로 여기를 열어두면 본문만 막는 것이 의미가 없다.
 *
 * @근거 설계 검수 입력 토큰 상한을 구조로 고정 — 비용이 본문 길이에 선형이다
 */
export const REPORT_TEXT_LIMITS = {
  title: 100,
  summary: 300,
  content: 1_000,
} as const;

/** 리포트 본문 검증 — 초안 저장 시점에 적용 (게시 전에 이미 막힌다) */
export function validateReportText(text: {
  title: string;
  summary: string;
  content: string;
}): string[] {
  const issues: string[] = [];
  for (const [field, label] of [
    ['title', '제목'],
    ['summary', '요약'],
    ['content', '본문'],
  ] as const) {
    const value = text[field].trim();
    if (value.length === 0) {
      issues.push(`${label}을(를) 입력해주세요`);
      continue;
    }
    const limit = REPORT_TEXT_LIMITS[field];
    if (value.length > limit) {
      issues.push(`${label}은(는) ${limit}자 이내여야 합니다 (현재 ${value.length}자)`);
    }
  }
  return issues;
}

/**
 * 리서처당 자산군별 동시 활성(게시·미판정·미철회) 카드 상한.
 *
 * ── 이 값에는 최적값이 없다 ──────────────────────────────────
 * 시뮬레이션으로 풀리는 상수가 아니다. 재려면 "카드 한 장이 더 열릴 때 늘어나는
 * 스팸"과 "그만큼 좁아지는 정직한 리서처의 활동"을 같은 자로 재야 하는데, 둘은 단위가
 * 다르다. 그래서 여기 적을 수 있는 근거는 유도 과정이 아니라 **무엇과 무엇을
 * 맞바꿨는지**다 — 이 값을 고칠 사람이 알아야 할 것은 그것이다.
 *
 *   노출 총량을 막는다  ↔  신규 리서처의 진입 폭이 좁아진다
 *
 * 이 교환을 받아들인 이유: **판매 수익이 동기라 점수로는 억제되지 않는다.**
 * 규율 래더는 거짓 신고를 잡지만 정직하게 낮은 신뢰도로 많이 내는 것은 잡지 않는다 —
 * 그건 거짓말이 아니라 그냥 실력이 없는 것이고, 점수로는 카드당 −4점 수준이라 어떤
 * 문턱에도 닿지 않는다. 점수가 닿지 못하는 동기는 **총량으로만** 막을 수 있다.
 *
 * 올릴 때 각오할 것: 스팸의 노출이 선형으로 는다. 내릴 때 각오할 것: 무표기 등급이
 * 실적을 쌓을 창구가 그만큼 좁아지고, 콜드스타트 이탈이 늘어난다.
 * (등급을 따라 여는 이유가 이것이다 — 검증된 사람에게는 이 교환의 오른쪽이 가볍다)
 *
 * 목적: **물량**을 막는다. 규율 래더(docs/score-discipline-sim.md)는 거짓 신고를
 * 잡지만, 정직하게 낮은 신뢰도로 많이 내는 것은 잡지 않는다 — 그건 거짓말이 아니라
 * 그냥 실력이 없는 것이고, 점수로는 카드당 −4점 수준이라 어떤 문턱에도 닿지 않는다.
 * 그런데 그 동기는 점수가 아니라 **판매 수익**이라 점수로는 애초에 억제되지 않는다.
 * 그래서 노출 총량 자체를 제한한다 — 이 상한이 물량 쪽의 유일한 방어선이다.
 * 검증 전 신규(무표기)는 소수의 카드에 집중하게 좁게 열고,
 * 검증된 상위 등급일수록 슬롯이 늘어난다.
 * 판정·철회로 카드가 닫히면 슬롯이 즉시 회수된다.
 *
 * @근거 설계 노출 총량 ↔ 신규 진입 폭의 교환 — 판매 수익이 동기라 점수로는 억제되지 않는다
 */
export const MAX_ACTIVE_CARDS: Record<Tier, number> = {
  BRONZE: 5,
  SILVER: 7,
  GOLD: 10,
  PLATINUM: 12,
  CHALLENGER: 15,
};

/**
 * 자산군을 **합친** 동시 활성 카드 상한 — 자산군별 상한의 1.6배(반올림).
 *
 * ── 왜 총량 상한이 따로 필요한가 (2026-08-13, scripts/simAssetClassSplit.ts) ──
 * 위 상한이 자산군별이라, 셋에 나눠 내면 동시에 여는 카드가 5장이 아니라 **15장**이
 * 된다. 증거·규율도 자산군별이라 저장고가 셋으로 갈리는데, **래더가 각 저장고에서
 * 문턱에 닿는 속도는 그대로다**(실측 1년 발동 시점 147일 대 146일).
 * 즉 분할은 탐지를 피하지 못하지만 **같은 시간 동안 3배를 판다** —
 * 발동 전에 팔린 ★4+ 카드가 1.50장에서 4.25장이 됐다.
 *
 * (처음에는 "나누면 자산군당 표본이 1/3이라 탐지가 무너진다"고 봤는데 틀렸다.
 *  몰아서 자주 내면 카드가 더 겹치고 상관 보정이 그만큼 깎으므로 두 효과가 상쇄된다.
 *  피해는 증거 희석이 아니라 **물량**에서 온다.)
 *
 * 1.6배인 이유 — 총량을 조일수록 피해는 줄지만 **오작동이 오른다.** 물량이 줄면
 * 카드 간격이 벌어져 덜 겹치고, 상관 보정이 정직한 사람을 감싸주던 몫이 얇아진다:
 *
 *   3자산군 1년      표적 게시   발동전 ★4+   정직한 사람 오작동
 *     상한 없음        183장       4.25          0.64%
 *     전체 12장        138장       3.53          1.01%
 *     **전체 8장**      93장       **2.07**      **2.90%**
 *     전체 6장          75장       1.82          4.20%
 *
 * 8장(=5×1.6)에서 피해가 한 자산군만 하는 경우(1.50)에 근접하면서 오작동은
 * α=10%에 여유가 남는다. 6장 이하는 피해가 조금 더 줄지만 오작동이 4%대로 뛴다.
 * **한 자산군만 다루는 리서처는 영향을 받지 않는다**(실측 61장 그대로).
 *
 * 자산군별 상한에서 유도한다 — 두 곳에 적어 두면 한쪽을 고칠 때 다른 쪽이 어긋난다.
 *
 * @근거 시뮬 scripts/simEvidenceCorrelation.ts — 전체 8장에서 오작동 2.90%
 */
export const MAX_ACTIVE_CARDS_TOTAL: Record<Tier, number> = Object.fromEntries(
  Object.entries(MAX_ACTIVE_CARDS).map(([tier, n]) => [tier, Math.round(n * 1.6)]),
) as Record<Tier, number>;

/** 이 시한(일)을 넘으면 **장기 카드** — 한 시즌(91일) 안에 판정이 끝나지 않는다 */
/** @근거 설계 한 시즌(91일) 안에 판정이 끝나지 않는 경계 */
export const LONG_HORIZON_DAYS = 90;

/**
 * 판정 이력이 없는 리서처가 걸 수 있는 시한의 상한 — **두 시즌.**
 *
 * `LONG_HORIZON_DAYS`(90)를 쓰지 않는 이유: 그 문턱은 **판정 유예 악용**을 막는
 * 장치라 목적이 다르다. 여기서 막으려는 것은 악용이 아니라 **콜드스타트 이탈**이다.
 * 90일 카드는 한 시즌 안에 판정이 나 등급 평가도 한 번 받는다 — 그걸 막으면
 * 신규의 기간 선택을 이유 없이 좁힐 뿐이다. 문제가 되는 것은 365일짜리다:
 * 신규는 100% 성과 연동이라 **1년 동안 정산도 실적도 0**인 채로 버텨야 한다.
 *
 * 두 시즌으로 끊으면 "첫 판정까지 최대 반년"이 보장되고, 그 사이 등급 재산정도
 * 두 번 돈다. 콜드스타트에서 이탈이 나는 구간을 덮으면서 정상적인 중장기 예측은
 * 그대로 살린다.
 *
 * @근거 설계 두 시즌 — 콜드스타트 이탈 구간을 덮되 중장기 예측은 살린다
 */
export const NEW_RESEARCHER_MAX_HORIZON_DAYS = LONG_HORIZON_DAYS * 2;

/**
 * 그 상한이 풀리는 조건 — 판정이 끝난 카드 1건.
 *
 * 1인 이유: 목적이 실력 검증이 아니라 **사이클을 한 번 겪게 하는 것**이다.
 * 판정 → 정산 또는 환불이 한 번 돌면 리서처는 이 플랫폼이 실제로 어떻게 굴러가는지
 * 알게 되고, 그 뒤의 기간 선택은 본인 몫이다. 더 높이면 실력 문턱이 되어 버리는데
 * 그건 이 규칙이 할 일이 아니다(그건 등급과 규율 래더가 한다).
 *
 * @근거 설계 실력 검증이 아니라 사이클을 한 번 겪게 하는 것이 목적이다
 */
export const JUDGED_BEFORE_LONG_CARDS = 1;

/**
 * 그중 **장기 카드**가 차지할 수 있는 슬롯 — 활성 상한의 절반(내림, 최소 1).
 *
 * ── 왜 따로 막나 (2026-08-13) ─────────────────────────────────
 * 위 상한은 **물량**을 막지만 **기간**을 막지 않는다. 슬롯 전부를 365일 카드로
 * 채우면 한 해 내내 ★5 카드가 진열대에 남는데 **판정이 하나도 나오지 않는다** —
 * 미판정 카드는 증거(Judgment.info)에 들어가지 않으므로 규율 래더가 볼 것이
 * 없다. 물량은 막혔지만 노출 기간은 무제한인 셈이다.
 *
 * 절반인 이유: 나머지 절반이 계속 회전하면 판정이 꾸준히 나와 래더가 볼 표본이
 * 생긴다. 무표기(슬롯 5)라면 장기 2 + 회전 3인데, 30일 카드로 3슬롯을 돌리면
 * 연 36장이 판정된다 — 래더가 표적을 잡는 데 충분한 크기다(1년 74장에서 표적
 * 발동 67.6%, scripts/simDisciplineRealtime.ts).
 *
 * 상한에서 유도한다 — 두 곳에 적어 두면 한쪽을 고칠 때 다른 쪽이 조용히 어긋난다.
 *
 * @근거 시뮬 scripts/simDisciplineRealtime.ts — 절반이 회전해야 래더가 볼 표본이 생긴다
 */
export const MAX_ACTIVE_LONG_CARDS: Record<Tier, number> = Object.fromEntries(
  Object.entries(MAX_ACTIVE_CARDS).map(([tier, n]) => [tier, Math.max(1, Math.floor(n / 2))]),
) as Record<Tier, number>;

/**
 * 검증 시한 최소(자산군별)·최대.
 *
 * **고른 값이 아니라 기준가 확정 방식이 정하는 값이다.** 최소 시한은 조작 방지
 * 장치이고, 막으려는 것 하나다 — 게시 시점에 **이미 실현된 등락을 공짜로 가져가는 것**.
 * 그래서 "기준가가 게시 이후의 정보로만 정해지는 가장 이른 시점"이 곧 이 값이다:
 *
 * - CRYPTO 1일: 게시 순간의 실시간 현재가가 기준가라(업비트 ticker) 게시 시점에
 *   이미 확정된 등락이 없다. 24시간 거래라 "당일 종가"라는 개념 자체가 없어 1일이 최소다
 * - KR/US EQUITY 0일: 당일 종가를 기준가로 쓸 수 있는지가 **게시 시각**에 달렸고,
 *   그 판단은 컷오프 규칙(planBaseMode)이 한다. 여기서 다시 막으면 같은 규칙이
 *   두 곳에 생겨 언젠가 갈라진다 — 그래서 0으로 열어 두고 컷오프에 맡긴다
 *
 * 즉 이 상수를 고치는 것은 정책 조정이 아니라 **기준가 규칙과의 정합성을 깨는 일**이다.
 *
 * @근거 규칙 기준가가 게시 이후 정보로만 정해지는 가장 이른 시점 — planBaseMode와 짝이다
 */
export const DEADLINE_MIN_DAYS: Record<AssetClass, number> = {
  KR_EQUITY: 0,
  US_EQUITY: 0,
  CRYPTO: 1,
};
/** @근거 설계 1년 — 시즌 넷을 넘기는 카드는 판정 약속을 지킬 수 없다 */
export const DEADLINE_MAX_DAYS = 365;

/**
 * 이 시한(일) 미만의 주식 카드는 컷오프 규칙(planBaseMode)을 따른다.
 *
 * ── 무엇이 걸려 있나 ────────────────────────────────────────────
 *   · 시한 ≥ 이 값 → `FIXED_AT_PUBLISH`: 기준가 = **게시 순간 가격**, 아무 때나 게시
 *   · 시한 < 이 값 → 컷오프 규칙: 개장 전에 내거나(기준가 = 직전 거래일 종가),
 *     그 외 시각이면 시한을 +2일 이상으로 밀어야 한다(기준가 = 게시 이후 첫 종가)
 *
 * ── 왜 문턱이 필요한가 ──────────────────────────────────────────
 * `FIXED_AT_PUBLISH`의 기준가는 **장중 한 순간의 가격**인데 판정은 **종가**로 한다.
 * 게시 시각은 리서처가 고르므로, **예측력이 0이어도** 그날 눌린 순간에 상승 카드를
 * 내면 목표선이 가까워진다 — 분석이 아니라 기다림만 필요하다. 컷오프 규칙 쪽에는
 * 이 구멍이 없다: 직전 거래일 종가는 이미 확정된 공개 숫자라 고를 수 없고,
 * 게시 이후 첫 종가는 아직 안 일어난 값이라 고를 수 없다.
 *
 * ── 14의 근거 (2026-08-16 실측, scripts/simShortHorizonCutoff.ts) ──
 * 이 값은 오래 **7**이었고 근거가 기록돼 있지 않았다. 재서 14로 올렸다.
 *
 * 잰 것: "예측력 0인 사람이 **게시 시각만 골라서** 얻는 카드당 기대 점수" — σ 추정기를
 * 고칠 때 쓴 것과 같은 잣대다(모델 p₀가 정확하면 반드시 0). 경로 30,000개 × 방향 2,
 * 장중 78틱(5분봉), σ 세 분위. **시즌 20장 누적을 시니어 승급선(1,200점)에 견준 값**:
 *
 *   시한   1일    3일    5일    7일    10일  **14일**  21일   30일
 *   최악  19.0%  11.5%  9.9%   7.9%   5.8%  **3.9%**  2.2%   0.6%
 *
 * ⚠ **방향을 합쳐 재면 안 된다** — 첫 판에서 실제로 틀렸다. 로그 장벽 거리가 상승은
 *   ln(1+M), 하락은 |ln(1−M)|이라 큰 크기에서 두 배까지 갈린다(M=65%면 0.50 vs 1.05).
 *   두 방향을 평균 낸 실측을 상승 전용 p₀와 견주면 **모델이 8%p 틀린 것처럼 보인다.**
 *   실제로는 모델이 맞고(몬테카를로 오차 ≤1.1%p, simMagnitudeFloor ②가 검증) 비교가
 *   틀린 것이었다. 파머는 유리한 방향을 고르므로 **방향별로 재서 나쁜 쪽**을 쓴다.
 *
 * ── 왜 7이 아니라 14인가 ────────────────────────────────────────
 * 7일은 **7.9%**로 가장 느슨한 바(5%)도 넘는다. 올리는 대가는 처음 생각보다 작았다 —
 * 7~13일 카드가 잃는 것은 **"장중·장후·주말에 게시하면서 목표가형으로 쓰는" 선택지
 * 하나뿐**이다. 개장 전에 내면 기준가가 게시 시점에 확정되므로 아무것도 잃지 않고,
 * 수익률형 크기 하한은 초안 검증에서 이미 걸린다.
 *
 * 그리고 이 누수에는 **2차 방어선이 없다.** 규율 래더는 정보량 D가 **음수**로 쌓여야
 * 발동하는데 이 누수는 D를 **양수**로 만든다 — 잡을 장치가 문턱뿐이다.
 *
 * 30일(0.6%)까지 올리지 않는 이유: 7~29일 띠 전체가 대가를 치르는데 얻는 것은
 * 3.9% → 0.6%다. 그리고 아래 상한 가정을 감안하면 3.9%는 실제로 그보다 작다.
 *
 * ⚠ 위 수치는 **상한**이다 — 하루 78틱 중 최저점을 정확히 집어낸다고 가정했다.
 *   실제 리서처가 그 절반만 잡아내면 14일의 누수는 2% 아래다.
 * ⚠ 30일 이후 0으로 떨어지는 것은 우위가 사라져서가 아니라 **신뢰도 사다리가 성겨서**다:
 *   가장 낮은 칸(c=2)이 이미 승산 ×1.73을 신고하는데 실제 우위가 그보다 작아,
 *   신고하는 순간 기대값이 음수가 된다. **사다리 자체가 필터로 작동한다.**
 *
 * @근거 시뮬 scripts/simShortHorizonCutoff.ts — 시각 선택 이득이 시니어선의 3.9%
 */
export const EQUITY_SHORT_HORIZON_DAYS = 14;

/** 장 시작 후·주말 게시 단기 카드의 최소 시한: 게시일로부터 N일 (시장 시간대 날짜 기준) */
/** @근거 설계 게시 이후 첫 정규장 종가를 기준가로 쓸 수 있는 최소 간격 */
export const AFTER_CUTOFF_MIN_DEADLINE_DAYS = 2;

/**
 * "당일 체결 정보가 아직 없다"고 볼 수 있는 개장 전 컷오프 — 국내주식만 존재한다.
 * - KR 08:00 KST: 대체거래소 NXT 프리마켓(08:00~)과 KRX 장전 시간외(08:00~)가 시작되어
 *   가격 발견이 일어나는 시점. 그 전(전일 20:00 NXT 마감 ~ 당일 08:00)은 거래 공백이라
 *   직전 종가 기준의 당일 예측이 깨끗하다
 * - US: 이런 창구가 없다. 애프터마켓(전일 16~20시 ET) → 주간거래·오버나이트 ATS
 *   (20~04시 ET, 국내 증권사 '주간거래' = 한국 낮 시간) → 프리마켓(04~09:30 ET)이
 *   사실상 연속이라 정보 공백 시점이 존재하지 않는다 → 당일 카드 불가,
 *   단기 카드는 항상 게시일+2일(기준가 = 게시 이후 첫 정규장 종가)
 *
 * @근거 규칙 NXT 프리마켓·KRX 장전 시간외 개시 시각(08:00 KST)
 */
export const KR_PUBLISH_CUTOFF = {
  timeZone: 'Asia/Seoul',
  cutoff: '08:00',
  label: 'NXT 프리마켓·장전 시간외 시작 전(08:00 KST)',
} as const;

/** 정규장 마감 시각 — 이후 게시는 그날 종가가 이미 공개된 뒤라 기준일을 다음 거래일로 굴린다 */
/** @근거 규칙 거래소 정규장 마감 시각 */
export const EQUITY_REGULAR_CLOSE: Record<Exclude<AssetClass, 'CRYPTO'>, string> = {
  KR_EQUITY: '15:30',
  US_EQUITY: '16:00',
};

const TICKER_PATTERNS: Record<AssetClass, RegExp> = {
  KR_EQUITY: /^\d{6}$/, // 6자리 단축코드
  US_EQUITY: /^[A-Z][A-Z.]{0,9}$/, // 심볼 (BRK.B 등 클래스 표기 허용)
  CRYPTO: /^KRW-[A-Z0-9]{2,10}$/, // 업비트 KRW 마켓코드
};

export interface CardDraft {
  assetClass: AssetClass;
  ticker: string;
  assetName: string;
  /** 방향: UP = buy, DOWN = sell */
  direction: Direction;
  targetType: TargetType;
  /** 크기: 목표가 또는 목표 등락률(%) */
  targetValue: number;
  /** 기간(검증 시한) */
  deadline: Date;
  /** 신뢰도 2~10 (필수) — 적중 확률 신고. 한 칸이 무정보 대비 승산 ×1.73 */
  confidence: number;
  /** @deprecated 자기 신고 안정성 — v4에서 폐지, 스키마 호환용으로 1 고정 전송 */
  selfStability: number;
  /**
   * 그 종목의 실현 변동성 (최근 120거래일). **크기 하한이 이 값으로 정해진다.**
   * 없으면 자산군 σ̄로 물러선다 — 작성 화면은 종목을 고르는 순간 받아 하한을 보여준다.
   */
  sigmaDaily?: number | null;
}

export interface PublishConditions {
  priceKrw: number;
  prepaymentRatio: PrepaymentRatio;
  tier: Tier;
  promoActive: boolean;
  /**
   * 해당 자산군의 시즌 누적 **정보량**(Judgment.info의 합) — 규율 래더 판단용.
   * 점수가 아니라 정보량인 이유는 scoring.ts의 래더 주석에 있다(증거 ≠ 값어치).
   * 판정 이력이 없으면 0 — 규율 미발동.
   */
  assetClassEvidence?: number;
  /** 해당 자산군의 현재 활성(게시·미판정·미철회) 카드 수 — 동시 게시 상한 판단용 */
  activeCardCount?: number;
  /**
   * **모든 자산군을 합친** 활성 카드 수 — 자산군별 상한만으로는 셋에 나눠 내는 것으로
   * 물량이 3배가 된다 (MAX_ACTIVE_CARDS_TOTAL 주석).
   */
  activeCardCountTotal?: number;
  /**
   * 그중 **장기 카드**(시한 > LONG_HORIZON_DAYS)의 수 — 판정 유예 악용 방지용.
   * 미판정 카드는 증거에 들어가지 않으므로, 장기 카드로 슬롯을 다 채우면
   * 래더가 볼 표본이 영영 생기지 않는다 (MAX_ACTIVE_LONG_CARDS 주석).
   */
  activeLongCardCount?: number;
  /**
   * 지금까지 **판정이 끝난** 카드 수 — 0이면 아직 아무것도 증명되지 않은 사람이다.
   * 장기 카드 금지의 기준이 된다 (JUDGED_BEFORE_LONG_CARDS).
   */
  judgedCardCount?: number;
}

export class PublishValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join(' / '));
    this.name = 'PublishValidationError';
  }
}

/** 'YYYY-MM-DD' 두 날짜의 차이(일) */
function dateDiffDays(a: string, b: string): number {
  return (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export interface BaseModePlan {
  baseMode: BaseMode;
  issues: string[];
}

/**
 * 게시 시각과 시한으로 기준가 확정 방식을 결정한다 (조작 방지 규칙의 심장부).
 *
 * 주식 단기 카드(시한 `EQUITY_SHORT_HORIZON_DAYS` 미만):
 * - KR, 평일 08:00 KST 전(당일 체결 정보가 아직 없음): 당일 종가 예측부터 허용.
 *   기준가 = 직전 거래일 종가를 **게시 시점에 확정** (2026-08-16 변경 — 옛 방식은
 *   판정 시 소급이었고 근거는 금융위 D+1 지연이었는데, KIS 전환으로 사라졌다)
 * - KR 그 외 시각·주말, US 상시: 시한은 게시일로부터 2일 이상.
 *   기준가 = 게시 이후 첫 정규장 종가 소급 확정 — 게시 시점까지 실현된 등락이
 *   전부 기준가에 흡수되므로 게시 시각과 무관하게 정보 이점이 없다.
 *   (US는 애프터마켓·주간거래·프리마켓이 연속이라 '개장 전' 창구 자체가 없음)
 * 그 외(코인·장기 카드): 게시 시점 확정 (실시간가 또는 직전 종가)
 *
 * 공휴일은 거래일 달력(marketCalendar)으로 걸러 주말과 똑같이 다룬다. 달력 범위를
 * 벗어난 날짜는 거래일로 보게 되는데, 그때도 그날 시세가 없으면 판정이 이월 후
 * 수동 보류 큐로 가므로 오판정으로 이어지지는 않는다.
 */
export function planBaseMode(
  assetClass: AssetClass,
  deadline: Date,
  now: Date,
): BaseModePlan {
  const horizonDays = (deadline.getTime() - now.getTime()) / 86_400_000;
  if (assetClass === 'CRYPTO' || horizonDays >= EQUITY_SHORT_HORIZON_DAYS) {
    return { baseMode: 'FIXED_AT_PUBLISH', issues: [] };
  }

  const timeZone = assetClass === 'KR_EQUITY' ? KR_PUBLISH_CUTOFF.timeZone : 'America/New_York';
  const clock = marketClock(now, timeZone);

  if (assetClass === 'KR_EQUITY') {
    // 휴장일은 주말과 같다 — "당일 종가"가 존재하지 않는 날이라 이 창구를 열면 안 된다
    const closed =
      clock.weekday === 'Sat' ||
      clock.weekday === 'Sun' ||
      holidayName('KR_EQUITY', clock.date) !== null;
    if (!closed && clock.time < KR_PUBLISH_CUTOFF.cutoff) {
      // **소급이 아니라 게시 시점 확정이다** (2026-08-16). 직전 거래일 종가는 어제
      // 마감 +5분에 이미 확정된 값이고, KIS는 개장 전에도 그대로 준다(실측).
      // 미루던 이유(금융위 D+1 지연)는 2026-08-10 KIS 전환으로 사라졌다
      return { baseMode: 'PREV_CLOSE_AT_PUBLISH', issues: [] };
    }
  }

  // 기준가 = 게시 이후 첫 종가이므로, 시한은 그 이후 거래일이어야 의미가 있다
  const deadlineDate = new Intl.DateTimeFormat('sv-SE', { timeZone }).format(deadline);
  const diff = dateDiffDays(deadlineDate, clock.date);
  const guide =
    assetClass === 'KR_EQUITY'
      ? `당일·익일 예측은 ${KR_PUBLISH_CUTOFF.label}에만 게시할 수 있습니다`
      : '미국주식은 애프터마켓·주간거래·프리마켓이 연속이라 당일·익일 예측 창구가 없습니다';
  const issues =
    diff < AFTER_CUTOFF_MIN_DEADLINE_DAYS
      ? [
          `${assetClass} 단기 예측: 시한이 게시일로부터 ${AFTER_CUTOFF_MIN_DEADLINE_DAYS}일 이상이어야 합니다 (요청: ${diff}일). ${guide}`,
        ]
      : [];
  return { baseMode: 'DAY_CLOSE_AT_JUDGMENT', issues };
}

/**
 * 하한 미달 안내 — **왜 이 숫자인지**까지 적는다.
 * 하한이 종목·기간마다 달라지므로 "최소 5%"처럼 외울 수 있는 값이 아니게 됐다.
 * 이유를 함께 주지 않으면 리서처에게는 그냥 임의의 벽으로 보인다.
 */
function magnitudeFloorMessage(floor: number, requested: number): string {
  return (
    `이 종목·기간의 예측 크기 하한은 ${floor.toFixed(1)}%입니다 (요청: ${requested}%). ` +
    '하한은 종목의 최근 120거래일 변동성과 검증 기한으로 정해집니다 — ' +
    '변동성이 큰 종목일수록 저절로 닿을 확률이 높아 더 큰 크기를 요구합니다.'
  );
}

export function validateCardDraft(card: CardDraft, now = new Date()): string[] {
  const issues: string[] = [];

  if (!TICKER_PATTERNS[card.assetClass].test(card.ticker)) {
    issues.push(`${card.assetClass} 티커 형식이 아닙니다: ${card.ticker}`);
  }
  if (card.assetName.trim().length === 0) {
    issues.push('자산명이 비어 있습니다');
  }
  // 종목 유니버스·하락 예측 가능 여부는 종목 마스터(DB) 기준 — 서비스 레이어에서 검증
  // (instrumentService.validateListedInstrument)
  if (!Number.isFinite(card.targetValue) || card.targetValue <= 0) {
    issues.push(`목표 수치는 양수여야 합니다 (RETURN_PCT는 등락률 크기): ${card.targetValue}`);
  }
  // 초소형 크기 예측 방지: 수익률형은 초안 단계에서 즉시 검증 (목표가형은 기준가 확정 시)
  const horizonDays = (card.deadline.getTime() - now.getTime()) / 86_400_000;
  const floor = minMagnitudePct(card.assetClass, card.sigmaDaily, horizonDays);
  if (card.targetType === 'RETURN_PCT' && card.targetValue < floor) {
    issues.push(magnitudeFloorMessage(floor, card.targetValue));
  }
  // 수익성은 예측 크기에서 자동 산출된다(profitability.ts) — 입력 검증 대상이 아니다
  // 신뢰도 하한이 2인 이유는 scoring.CONFIDENCE_RANGE에 있다 —
  // c=1은 무정보 기대 점수가 정확히 0이라 스팸이 손해 없이 머무는 은신처였다.
  if (
    !Number.isInteger(card.confidence) ||
    card.confidence < CONFIDENCE_RANGE.min ||
    card.confidence > CONFIDENCE_RANGE.max
  ) {
    issues.push(
      `신뢰도는 ${CONFIDENCE_RANGE.min}~${CONFIDENCE_RANGE.max} 정수여야 합니다: ${card.confidence}` +
        (card.confidence === 1
          ? ' — 신뢰도 1은 어떤 예측이든 기대 점수가 0이라 사용할 수 없습니다'
          : ''),
    );
  }
  // 안정성 자기 신고는 v4에서 폐지됐고 스키마 호환용으로만 남아 있다 (1 고정 전송)
  if (!Number.isInteger(card.selfStability) || card.selfStability < 1 || card.selfStability > 10) {
    issues.push(`안정성(자기 평가)은 1~10 정수여야 합니다: ${card.selfStability}`);
  }

  const daysToDeadline = (card.deadline.getTime() - now.getTime()) / 86_400_000;
  const minDays = DEADLINE_MIN_DAYS[card.assetClass];
  if (daysToDeadline < minDays) {
    issues.push(`${card.assetClass} 검증 시한은 최소 ${minDays}일 이후여야 합니다`);
  }
  if (daysToDeadline > DEADLINE_MAX_DAYS) {
    issues.push(`검증 시한은 최대 ${DEADLINE_MAX_DAYS}일 이내여야 합니다`);
  }

  return issues;
}

export function validateConditions(cond: PublishConditions): string[] {
  const issues: string[] = [];
  if (
    !Number.isInteger(cond.priceKrw) ||
    cond.priceKrw < PRICE_GUIDE_KRW.min ||
    cond.priceKrw > PRICE_GUIDE_KRW.max
  ) {
    issues.push(
      `가격은 ${PRICE_GUIDE_KRW.min.toLocaleString()}~${PRICE_GUIDE_KRW.max.toLocaleString()}원 범위의 정수여야 합니다: ${cond.priceKrw}`,
    );
  }
  try {
    calcFeeRateBp(cond); // 등급별 선결제 상한 검증 포함
  } catch (e) {
    issues.push((e as Error).message);
  }
  return issues;
}

export interface PublishSnapshot {
  /** 게시 시점 확정 총 수수료 (bp) — 판매 중 변경 불가 */
  feeRateBp: number;
  /** 기준가 확정 방식 — KR 단기 카드는 판정 시 소급 확정 */
  baseMode: BaseMode;
  /** FIXED_AT_PUBLISH면 확정값, AT_JUDGMENT면 null (판정 배치가 기록) */
  basePrice: number | null;
  publishedAt: Date;
}

/**
 * 게시 스냅샷을 확정한다.
 * - 일반 카드: basePrice는 호출자가 시세 공급자에서 실측(실시간가 또는 직전 종가)해 넘긴다
 * - KR 단기 카드(`EQUITY_SHORT_HORIZON_DAYS` 미만): 개장 전이면 직전 거래일 종가로
 *   **게시 시점 확정**, 그 외 시각이면 게시 이후 첫 종가로 판정 시 소급 확정
 * 검증 실패 시 PublishValidationError — 부분 게시는 없다.
 */
export function preparePublish(
  card: CardDraft,
  cond: PublishConditions,
  basePrice: number | null,
  now = new Date(),
): PublishSnapshot {
  const issues = [...validateCardDraft(card, now), ...validateConditions(cond)];
  const plan = planBaseMode(card.assetClass, card.deadline, now);
  // **소급 = "게시 시점에 기준가를 모른다"**이지 "시장이 닫혀 있다"가 아니다.
  // 개장 전 게시 카드(PREV_CLOSE_AT_PUBLISH)는 직전 거래일 종가를 지금 읽을 수 있으므로
  // 여기 들어오지 않는다 — 그래서 크기 하한·방향 정합성 검증을 그대로 받고 목표가형도 쓴다
  const retroactive = plan.baseMode === 'DAY_CLOSE_AT_JUDGMENT';

  // 동시 활성 카드 상한: 신뢰도 1 저품질 대량 게시 차단 (자산군별, 등급별 슬롯)
  const maxActive = MAX_ACTIVE_CARDS[cond.tier];
  if ((cond.activeCardCount ?? 0) >= maxActive) {
    issues.push(
      `${card.assetClass} 동시 활성 카드가 상한(${TIER_NAME[cond.tier]} 등급 ${maxActive}건)에 도달했습니다 — 기존 카드가 판정되거나 철회되면 다시 게시할 수 있습니다`,
    );
  }

  // 총량 상한: 자산군을 나누는 것으로 물량을 3배로 여는 길을 막는다
  const maxTotal = MAX_ACTIVE_CARDS_TOTAL[cond.tier];
  if ((cond.activeCardCountTotal ?? 0) >= maxTotal) {
    issues.push(
      `전체 동시 활성 카드가 상한(${TIER_NAME[cond.tier]} 등급 ${maxTotal}건)에 도달했습니다 — 자산군을 나눠도 한 번에 여는 카드 수는 합쳐서 셉니다. 기존 카드가 판정되거나 철회되면 다시 게시할 수 있습니다`,
    );
  }

  // 장기 카드 슬롯: 판정이 영영 안 나오는 ★5 진열대를 막는다 (MAX_ACTIVE_LONG_CARDS)
  // 초안 검증(validateCardDraft)과 같은 식으로 잰다 — 두 곳이 갈라지면
  // 경계에서 "게시는 되는데 장기로 안 세어지는" 카드가 생긴다
  const horizonDays = (card.deadline.getTime() - now.getTime()) / 86_400_000;

  // **판정을 한 번도 받아 본 적 없는 사람은 아주 긴 카드를 걸 수 없다.**
  //
  // 이건 리서처를 막는 규칙이 아니라 **리서처를 지키는 규칙**이다. 신규는 100% 성과
  // 연동이라, 첫 카드를 365일로 걸면 **1년 동안 한 푼도 못 받고 실적도 0인 상태**로
  // 버텨야 한다 — 콜드스타트에서 이탈이 나는 자리가 정확히 여기다. 한 번 판정을
  // 받으면 정산이든 환불이든 **사이클이 돌았다는 사실**이 남고, 그때부터는 본인이 고른다.
  //
  // 등급이 아니라 **판정 이력**을 기준으로 삼는 이유: 무표기에는 "아직 아무것도 안 한
  // 사람"과 "판정은 여럿 받았지만 점수가 모자란 사람"이 섞여 있다. 뒤쪽까지 묶으면
  // 실적 있는 사람의 기간 선택을 이유 없이 뺏는다
  if (
    horizonDays > NEW_RESEARCHER_MAX_HORIZON_DAYS &&
    (cond.judgedCardCount ?? 0) < JUDGED_BEFORE_LONG_CARDS
  ) {
    issues.push(
      `아직 판정이 끝난 예측이 없어 시한 ${NEW_RESEARCHER_MAX_HORIZON_DAYS}일 초과 카드는 게시할 수 없습니다 — ` +
        `첫 판정까지 1년을 기다리면 그동안 정산도 실적도 0입니다. 판정을 한 번 받으면 바로 열립니다`,
    );
  }

  if (horizonDays > LONG_HORIZON_DAYS) {
    const maxLong = MAX_ACTIVE_LONG_CARDS[cond.tier];
    if ((cond.activeLongCardCount ?? 0) >= maxLong) {
      issues.push(
        `${card.assetClass} 시한 ${LONG_HORIZON_DAYS}일 초과 카드가 상한(${TIER_NAME[cond.tier]} 등급 ${maxLong}건)에 도달했습니다 — 장기 카드는 판정이 늦어 실적이 쌓이지 않으므로 동시에 여는 수를 제한합니다`,
      );
    }
  }

  // 규율 래더: 게시 정지 또는 신뢰도 **상한** (자산군별)
  const discipline = disciplineFor(cond.assetClassEvidence ?? 0);
  if (discipline.publishSuspended) {
    issues.push(
      `${card.assetClass} 신규 게시가 정지되었습니다 — 신고한 확신이 실제 적중과 거듭 어긋났습니다. 이후 적중이 쌓이면 자동으로 풀립니다. 진행 중인 카드는 정상 판정·정산됩니다`,
    );
  } else if (card.confidence > discipline.maxConfidence) {
    issues.push(
      `현재 ${card.assetClass} 실적에서는 신뢰도 ${discipline.maxConfidence} 이하로만 게시할 수 있습니다 (입력: ${card.confidence}) — 신고한 확신이 적중으로 뒷받침되지 않는 동안 확신 표시를 제한합니다. 적중이 쌓이면 자동으로 풀립니다`,
    );
  }

  if (retroactive) {
    issues.push(...plan.issues);
    // 소급 확정 카드는 게시 시점에 기준가가 없어 목표가의 방향 정합성·크기 하한을
    // 검증할 수 없다 → 수익률형만 허용 (크기 하한은 초안 검증에서 이미 처리됨).
    // **개장 전 게시 카드는 2026-08-16부터 여기 해당하지 않는다** — 기준가를 게시
    // 시점에 확정하므로 목표가형을 쓸 수 있고 아래 정합성 검증도 그대로 받는다
    if (card.targetType === 'TARGET_PRICE') {
      issues.push(
        '기준가를 판정 시 소급 확정하는 단기 카드는 수익률형(RETURN_PCT)만 허용됩니다',
      );
    }
  } else {
    if (basePrice === null || !Number.isFinite(basePrice) || basePrice <= 0) {
      issues.push(`기준가를 확정할 수 없습니다 (시세 조회 결과: ${basePrice})`);
    }
    // 목표가형은 방향·크기의 정합성 검증 (상승 예측인데 목표가가 기준가 이하 등)
    if (card.targetType === 'TARGET_PRICE' && basePrice !== null && basePrice > 0) {
      if (card.direction === 'UP' && card.targetValue <= basePrice) {
        issues.push(`상승 예측의 목표가(${card.targetValue})가 기준가(${basePrice}) 이하입니다`);
      }
      if (card.direction === 'DOWN' && card.targetValue >= basePrice) {
        issues.push(`하락 예측의 목표가(${card.targetValue})가 기준가(${basePrice}) 이상입니다`);
      }
      const magnitude = targetPriceToMagnitudePct(card.targetValue, basePrice);
      const floor = minMagnitudePct(
        card.assetClass,
        card.sigmaDaily,
        (card.deadline.getTime() - now.getTime()) / 86_400_000,
      );
      if (magnitude < floor) {
        issues.push(magnitudeFloorMessage(floor, Number(magnitude.toFixed(1))));
      }
    }
  }

  if (issues.length > 0) {
    throw new PublishValidationError(issues);
  }

  return {
    feeRateBp: calcFeeRateBp(cond),
    baseMode: plan.baseMode,
    basePrice: retroactive ? null : basePrice,
    publishedAt: now,
  };
}
