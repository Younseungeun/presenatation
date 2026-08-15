import type { Prisma, PrismaClient } from '@prisma/client';
import type { AssetClass, Direction, TargetType } from '@/domain/constants';
import {
  JudgmentDeferredError,
  ProviderUnavailableError,
  runJudgmentFromRegistry,
} from '@/domain/judgmentPipeline';
import type { ProviderRegistry } from '@/domain/marketData';
import {
  JudgmentDisagreementError,
  resolveCrossCheckMode,
  type CrossCheckMode,
} from '@/domain/crossCheck';
import { scoreJudgedCard } from '@/domain/scoring';
import { toJudgeableCard } from './cardMapper';
import { rebaseIfAdjusted } from './corporateActionService';
import { buildJudgmentWrites } from './judgmentWriter';
import { memoizeRegistry } from '@/infra/marketData/memoRegistry';
import { beginRecovery, shouldDelayHardCap } from './crossCheckRecovery';
import {
  isJudgmentPaused,
  pausedAssetClasses,
  setJudgmentPause,
  SYSTEM_PAUSE_ACTOR,
} from './judgmentPause';

// 판정 배치: 시한이 지난 미판정 카드를 찾아 판정 → 점수 산정 → 에스크로 정산까지
// 하나의 트랜잭션으로 실행한다 (docs/market-data.md §4).
// - 멱등성: Judgment.predictionCardId unique — 재실행해도 중복 판정 불가
// - 데이터 미도달: 이월 (deferred) — 다음 배치가 다시 시도
// - 이월이 STALE_DEFER_DAYS를 넘는 카드는 운영자 보류 큐 대상 (manualJudgmentService)

/** 소스 하나에 대한 빈 배열 집계 (BatchSummary.emptyRange) */
export interface EmptyRangeStat {
  /** 이번 회차에 이 소스로 판정을 시도한 카드 수 */
  attempted: number;
  /** 그중 구간 시세가 **빈 배열**로 온 카드 수 */
  empty: number;
  /** 빈 배열이 반복되는 종목 (같은 종목이 계속이면 소스가 아니라 종목의 문제다) */
  stuckTickers: string[];
}

export interface BatchSummary {
  judged: number;
  deferred: number;
  failed: number;
  /** 시한이 STALE_DEFER_DAYS 이상 지났는데 아직 판정 못 한 카드 — 수동 확인 필요 */
  staleDeferred: string[];
  /** 상한에 걸려 시스템이 판정 불가로 닫은 카드 — 전액 환불이 나갔으므로 사람이 알아야 한다 */
  hardCapped: string[];
  /** 반복된 판정 불가로 신규 게시를 막은 종목 — 유니버스에서 내린 것이라 사람이 알아야 한다 */
  blockedInstruments: string[];
  /**
   * 예상 밖 오류로 판정하지 못한 카드 — **이건 데이터 문제가 아니라 우리 버그다.**
   * 이월(staleDeferred)과 나눠 두는 이유는 처방이 다르기 때문이다: 이월은 기다리거나
   * 운영자가 시세를 넣으면 되지만, 이쪽은 코드를 고치기 전에는 몇 번을 돌려도 같다.
   */
  failures: string[];
  /**
   * **시세 공급자가 응답하지 못한 카드** (2026-08-15).
   *
   * 전에는 이것이 `failures`에 함께 담겨 "[버그] 코드 확인 필요"로 나갔다. 그런데 이
   * 통에 더 흔하게 들어오는 것이 공급자 장애이고, 그건 **기다리면 낫고 우리 코드를
   * 봐도 나올 것이 없다** — 알림이 운영자를 틀린 곳으로 보내고 있었다.
   *
   * 종목별로 세지 않고 **소스별로 묶는다**: 소스가 죽으면 그 소스를 쓰는 카드가 전부
   * 걸리므로 종목 목록은 길기만 하고 아무것도 말해 주지 않는다.
   */
  providerDown: Map<string, number>;
  /**
   * **두 시세 소스가 서로 다른 판정을 냈다** (domain/crossCheck, 2026-08-15).
   *
   * 이월과 따로 세는 이유는 **기다려도 낫지 않기 때문**이다. 다음 회차도, 그다음 회차도
   * 같은 두 값을 받아 같은 두 결론을 낸다. 그래서 이 카드는 백오프 사다리를 타지 않고
   * 곧장 **수동 판정 큐**로 간다 — 사람이 두 시세를 나란히 놓고 보는 것이 유일하게
   * 답이 있는 경로다.
   */
  disagreed: string[];
  /**
   * 불일치가 무더기로 나 **자동 판정을 정지시킨 자산군들** (shouldHaltOnDisagreement).
   *
   * 배열인 이유는 스코프 없는 회차(기동 따라잡기·수동 배치)가 여러 자산군을 한 번에
   * 돌기 때문이다. 그 경로에서 하나의 비율로 판단하면 **깨진 자산군이 멀쩡한 자산군에
   * 희석돼 정지가 안 걸린다.**
   */
  haltedAssetClasses: AssetClass[];
  /**
   * **공급자가 200 OK로 빈 배열을 준 카드** — 소스별 집계 (2026-08-15).
   *
   * 이것만 따로 세는 이유: 빈 배열은 **예외를 던지지 않는다.** 공급자 장애 감지에도,
   * 이상값 필터에도, 실패 통계에도 걸리지 않고 그냥 "이월"로 조용히 흘러간다.
   * 한 장이면 정상(그날 봉이 아직 안 올라옴)이고, 무더기로 나면 **판정과 정산이
   * 통째로 선 채 아무 신호가 없는 상태**다.
   *
   * `attempted`를 함께 세는 이유는 비율만으로도 건수만으로도 판단이 안 되기 때문이다
   * (scripts/runScheduler의 문턱 참고).
   */
  emptyRange: Map<string, EmptyRangeStat>;
  /**
   * 이번 회차에서 마지막으로 손댄 카드의 위치 — **다음 회차의 커서다.**
   *
   * 왜 개수가 아니라 커서인가: 이월된 카드는 Judgment 행이 안 생겨 다음 조회에도
   * 그대로 잡힌다. 커서 없이 `take 20`만 쓰면 **오래된 이월 20장이 매 회차 앞자리를
   * 차지해 그 뒤 카드는 영원히 판정되지 않는다.**
   *
   * 그리고 Prisma의 `cursor`(행 id 기반)를 쓸 수 없다 — 이 회차가 **자기가 방금 만든
   * 조건**(nextAttemptAt 백오프)으로 커서 행을 필터에서 밀어내기 때문이다. 커서 행이
   * where를 만족하지 않으면 페이지가 어긋난다(실제로 5장이 4장으로 나왔다).
   * 그래서 정렬 키(deadline, id) 자체를 조건으로 쓰는 **키셋 페이지네이션**을 쓴다.
   */
  cursor: { deadline: Date; id: string } | null;
  /** 커서 뒤에 더 있을 수 있다 — 스케줄러가 이어서 한 번 더 돈다 */
  hasMore: boolean;
}

/** 이월이 이 일수를 넘으면 운영자 보류 큐 대상 */
export const STALE_DEFER_DAYS = 7;

/**
 * **빈 배열 대량 발생 알림의 문턱** — 비율과 건수를 **둘 다** 넘어야 울린다 (2026-08-15).
 *
 * 어느 한쪽만 쓰면 둘 다 틀린다:
 *  · **비율만** — 그날 만기가 비인기 자산군에 2장뿐이었고 둘 다 비면 100%다.
 *    플랫폼의 위기가 아니라 그냥 조용한 날인데 P1이 울린다
 *  · **건수만** — 만기 10,000장 중 50장이 비면 0.5%다. 문턱을 50에 두면 작은 소스의
 *    전면 장애(20장 중 20장)를 놓치고, 5에 두면 큰 날마다 울린다
 *
 * 그래서 **소스별로** 비율 ≥ 50% **그리고** 건수 ≥ 5. 소스별인 이유는 사고의 단위가
 * 소스이기 때문이다 — 업비트가 멀쩡한데 KIS가 죽은 날 전체 비율은 아무것도 말하지 않는다.
 *
 * 그리고 이 조건이 못 잡는 갈래가 하나 더 있다: **소수 종목이 계속 비는 경우**
 * (0.5%의 그 50장). 비율로도 건수로도 안 걸리지만 그 종목의 카드는 영영 판정되지 않는다.
 * → `EMPTY_RANGE_STREAK`회 이상 이월된 종목은 비율과 무관하게 이름을 올린다.
 */
export const EMPTY_RANGE_RATIO = 0.5;
export const EMPTY_RANGE_MIN_CARDS = 5;
export const EMPTY_RANGE_STREAK = 3;

/**
 * **불일치가 무더기로 나면 그 자산군의 자동 판정을 통째로 세운다** (2026-08-15).
 *
 * 외부 검토가 안전 장치의 방향이 거꾸로였음을 짚었다. 전에는 "예상 불일치가 운영자
 * 처리 용량을 넘으면 enforce로 올리지 않는다"를 전환 조건에 뒀는데, 그러면 **시장
 * 급변·API 개편으로 불일치가 폭증하는 바로 그날 대조가 꺼지고** 신뢰가 깨진 단일
 * 소스로 자동 판정이 그대로 나간다. 용량 초과의 처방은 장치를 끄는 것이 아니라
 * **큐를 세우는 것**이다.
 *
 * 왜 불일치 카드만 빼지 않고 전부 멈추는가: 소스가 무더기 불일치를 낼 만큼 깨졌다면
 * **합의한 카드도 검증된 것이 아니다** — 그저 목표선을 사이에 두지 않았을 뿐이다.
 * 그 상태에서 나머지를 판정하는 것은 애초에 대조를 안 한 것과 같다.
 *
 * 문턱이 비율 **그리고** 건수인 이유는 빈 배열 알림과 같다(EMPTY_RANGE_RATIO 주석):
 * 대상이 2장인 조용한 날의 2/2가 100%로 울리면 안 되고, 목표선 근처 카드에서
 * **불일치가 드물게 나는 것은 정상**이라 한두 건은 수동 큐로 보내고 지나가야 한다.
 *
 * ── 문턱을 50%/5건 → 30%/3건으로 내렸다 (2026-08-15, 외부 검토) ─────────
 * 검토는 "전체 100건 중 특정 거래소 8건이 다 갈려도 8%라 안 걸린다"는 희석을 짚었다.
 * **전제는 사실과 달랐다** — 스케줄러는 시장 마감마다 자산군을 좁혀 부르므로 비율이
 * 이미 자산군별이다. 그런데 **결론은 두 가지 이유로 맞았다**:
 *  ① 스코프 없이 도는 경로가 있다(기동 따라잡기·수동 배치) — 아래에서 자산군별로 나눠 센다
 *  ② 한 자산군 안에서도 하위 묶음만 깨질 수 있다. 20장 중 8장이 갈려도 40%라 50%에 못 닿았다
 *
 * 그리고 비대칭이 문턱을 아래로 민다: **잘못된 정산은 비가역이고 정지는 가역이다.**
 * 정지의 대가는 지연이지만(그동안에도 14일 상한은 집행된다), 깨진 소스로 나간 판정은
 * 되돌려도 이미 알림이 나가고 돈이 움직인 뒤다.
 *
 * ── 전역 문턱은 두지 않는다 (검토의 2단계 안을 기각) ──────────────────
 * 검토는 "전체 20% 또는 **10건 이상**이면 엔진 전체 정지"를 제안했는데 둘 다 안 쓴다:
 *  · `OR 10건`은 **건수 단독 조건**이라, 만기 800장인 날 10건(1.25%)이 전 자산군을
 *    세운다 — 검토 자신이 빈 배열 논의에서 지적한 그 오류다
 *  · 자산군별 정지가 **이미 합성된다**: 진짜 전역 사고(우리 코드 버그)는 세 자산군
 *    모두에서 문턱을 넘어 각각 선다. 별도 전역 규칙이 더하는 것은 **코인이 깨졌을 때
 *    미국 주식을 함께 세우는 경로**뿐이고, 그건 사고를 옆으로 옮기는 일이다
 *    (judgmentPause 머리말이 "전역만 두지 않는" 이유로 이미 적어 둔 것과 같다)
 *
 * 시스템이 건 정지는 **재관측으로 스스로 풀 수 있다** (server/crossCheckRecovery).
 * 사람이 건 정지는 종전대로 사람만 푼다.
 */
export const DISAGREEMENT_HALT_RATIO = 0.3;
export const DISAGREEMENT_HALT_MIN = 3;

export function shouldHaltOnDisagreement(disagreed: number, attempted: number): boolean {
  return (
    disagreed >= DISAGREEMENT_HALT_MIN &&
    attempted > 0 &&
    disagreed / attempted >= DISAGREEMENT_HALT_RATIO
  );
}

/** 알림을 울려야 하는 소스만 골라 낸다 (scripts/runScheduler가 쓴다) */
export function emptyRangeAlerts(
  emptyRange: Map<string, EmptyRangeStat>,
): { sourceId: string; stat: EmptyRangeStat; bulk: boolean }[] {
  const out: { sourceId: string; stat: EmptyRangeStat; bulk: boolean }[] = [];
  for (const [sourceId, stat] of emptyRange) {
    const bulk =
      stat.empty >= EMPTY_RANGE_MIN_CARDS &&
      stat.attempted > 0 &&
      stat.empty / stat.attempted >= EMPTY_RANGE_RATIO;
    if (bulk || stat.stuckTickers.length > 0) out.push({ sourceId, stat, bulk });
  }
  return out;
}

/**
 * 한 회차에 처리할 카드 수 상한.
 *
 * 판정은 카드마다 시세를 부르는데 KIS는 **호출 간격 1.1초**다. 분기말처럼 시한이 몰린
 * 날 수백 장이 한 번에 들어오면 회차 하나가 수백 초를 잡아먹고, 그동안 큐 뒤의 다른
 * 배치(판매 마감·감시 갱신)가 통째로 밀린다. 토큰 만료·프로세스 재시작이라도 끼면
 * **그 회차가 통째로 날아간다** — 20장씩 끊으면 최악이 22초고, 죽어도 20장어치만 잃는다.
 *
 * 판정은 멱등이라 여러 회차로 나눠 돌아도 결과가 같다. 남은 수(remaining)를 돌려주면
 * 스케줄러가 그 자리에서 다시 부른다.
 */
export const JUDGE_BATCH_SIZE = 20;

/**
 * 이월 재시도 간격 — **실패할수록 뒤로 미룬다** (지수 백오프).
 *
 * 이월된 카드는 Judgment 행을 만들지 않아 다음 조회에도 그대로 잡힌다. 시세 소스가
 * 특정 종목에서 계속 실패하면(티커 변경·상폐 직전·데이터 공백) 그 카드가 매 회차
 * KIS 호출을 갉아먹는다 — 100건이면 회차마다 110초를 **아무 성과 없이** 쓴다.
 *
 * **마지막 눈금이 하루인 이유는 상한(Hard Cap)이 생겼기 때문이다.** 예전 마지막 눈금은
 * 사흘이었다 — 영영 실패하는 카드의 호출을 줄이려는 값이었고, 무기한 기다리는 설계에서는
 * 그게 맞았다. 지금은 14일에 시스템이 닫으므로 계산이 뒤집힌다:
 *  · 아끼는 것 — 상한까지 시도 7회가 14회로. 카드 한 장당 **KIS 호출 7번**이 는다(무시할 값)
 *  · 잃는 것 — 5일째 시세가 돌아와도 다음 시도가 8일째면 **사흘을 에스크로에 묶은 채** 헛산다.
 *    최악의 경우 상한 직전에 되살아난 데이터를 못 보고 판정 불가로 닫는다
 * 상한이 없던 때는 "언젠가는 잡힌다"가 참이라 간격이 길어도 손해가 없었지만, 끝을
 * 정해 둔 지금은 **간격이 곧 놓칠 확률**이다.
 *
 * 마지막 눈금은 클램프로 반복된다(nextAttemptAfterDefer) — 4회차 이후는 계속 하루 간격.
 */
export const DEFER_BACKOFF_MS = [
  // **첫 실패는 미루지 않는다.** 한 번의 결측은 대개 일시적이고(그날 봉이 아직 안 올라옴),
  // 같은 회차 안에서 같은 카드를 다시 만나는 것은 **커서**가 이미 막고 있다.
  // 백오프가 벌해야 하는 것은 첫 실패가 아니라 **반복되는 실패**다.
  0, // 1회 → 다음 회차에 바로 다시
  60 * 60_000, // 2회 → 1시간
  6 * 3_600_000, // 3회 → 6시간
  24 * 3_600_000, // 4회 이후 → 하루 (상한까지 매일 한 번씩 두드린다)
] as const;

/**
 * 백오프 눈금의 개수. **자동 재시도를 끊는 문턱이 아니다.**
 *
 * 처음에는 "이만큼 이월되면 조회에서 빼고 사람에게 넘긴다"로 썼는데 틀렸다 —
 * `deferCount`는 **시도 횟수지 시간이 아니다.** 기동 따라잡기(catchUpOnBoot)는 거래일을
 * 가리지 않고 도므로, pm2가 주말에 몇 번 재시작하면 **시간은 하나도 안 흘렀는데
 * 재시도 예산만 소진**되어 멀쩡한 카드가 운영자 큐로 밀려난다. 배포 한 번에도 같은 일이
 * 일어난다.
 *
 * 그래서 **정차는 시간으로 판단한다**(STALE_DEFER_DAYS). deferCount는 "얼마나 자주
 * 다시 볼까"만 정한다. 마지막 눈금이 하루라 영영 실패하는 카드도 하루 한 번만 부르므로
 * (상한까지 최대 14회), 조회에서 빼지 않아도 비용이 무시할 수준이고 **데이터가 돌아오면
 * 스스로 낫는다**.
 */
export const MAX_DEFER_ATTEMPTS = DEFER_BACKOFF_MS.length;

/**
 * 시한이 이만큼 지나도록 판정하지 못하면 **판정 불가로 끝낸다** (전액 환불).
 *
 * 이유는 소비자 약속이다. 구매자는 "이 시점까지 이 가격에 닿는가"를 샀는데, 시세 소스
 * 장애로 판정이 미뤄지는 것은 **전적으로 플랫폼 사정**이다. 그 사이 돈은 에스크로에
 * 묶여 있고, 약관에는 지연 상한이 없었다 — 사실상 무기한이었다.
 *
 * STALE_DEFER_DAYS(7일)보다 늦게 잡은 이유: 그 사이가 **사람이 손쓸 창구**다.
 * 7일에 운영자 큐로 올라가고, 그래도 아무도 손대지 못하면 14일에 시스템이 닫는다.
 * 둘을 같은 날로 두면 운영자에게 기회가 없다.
 */
export const JUDGMENT_HARD_CAP_DAYS = 14;

/**
 * 같은 종목이 이만큼 상한에 걸리면 **그 종목의 신규 게시를 막는다**.
 *
 * 상한은 구매자를 구하지만 원인을 고치지는 않는다 — 시세를 못 구하는 종목은 다음 카드도
 * 똑같이 판정 불가로 끝난다. 그때마다 리서처는 점수 0을 받고 구매자는 14일을 기다린다.
 * **판정할 수 없는 종목을 계속 파는 것 자체가 지킬 수 없는 약속**이라 진열대에서 내린다.
 *
 * 리서처가 직접 시세를 제출해 구제받는 창구는 열지 않는다 — 판정의 값어치는 전적으로
 * "플랫폼이 중립적인 원천으로 잰다"에서 오고, 당사자가 낸 숫자를 받는 순간 그게 사라진다.
 * 구제는 개별 판정을 뒤집는 것이 아니라 **유니버스를 고치는 것**이 맞다.
 *
 * 문턱이 1이 아니라 2인 이유: 소스 전체가 하루 죽으면 수십 종목이 한 번씩 걸린다.
 * **같은 종목**이 두 번 걸려야 종목의 문제다 — 한 번은 사건이고 두 번은 성질이다.
 *
 * 처분은 `unjudgeableAt` — **riskLevel과 다른 칸이다.** 검색에서 빠지고 신규 카드가
 * 막히는 결과는 DANGER와 같지만, riskLevel은 **거래소가 지정한 사실**이고 이쪽은
 * **우리 쪽 시세 소스의 한계**다. 처분이 같다고 한 칸에 담으면 공급자를 갈아 끼울 때
 * "진짜 상폐된 종목"과 "우리가 못 구해서 막아 둔 종목"을 쿼리로 구분할 수 없다.
 * **진행 중인 카드와 돈은 건드리지 않는다.** 마스터 동기화는 이 칸을 만지지 않으므로
 * 조용히 되살아나지 않고, 원인이 풀리면 `npm run risk:set -- --judgeable`로 되돌린다.
 */
export const HARD_CAP_BLOCK_THRESHOLD = 2;

/**
 * 반복해서 판정 불가가 난 종목의 신규 게시를 막는다. 막았으면 사유 문자열, 아니면 null.
 * (이 카드의 판정이 이미 기록된 뒤에 부른다 — count에 방금 것이 포함된다)
 */
async function blockUnjudgeableInstrument(
  prisma: PrismaClient,
  assetClass: string,
  ticker: string,
  now: Date,
): Promise<string | null> {
  const hardCaps = await prisma.judgment.count({
    where: {
      undecidableReason: 'DATA_UNAVAILABLE',
      predictionCard: { assetClass, ticker },
    },
  });
  if (hardCaps < HARD_CAP_BLOCK_THRESHOLD) return null;
  const inst = await prisma.instrument.findUnique({
    where: { assetClass_ticker: { assetClass, ticker } },
    select: { unjudgeableAt: true },
  });
  // 이미 막혀 있거나 마스터에 없으면 할 일이 없다 (마스터에서 사라진 종목은 상장폐지
  // 경로가 따로 처리한다 — 거기서는 전액 환불까지 이미 났다)
  if (!inst || inst.unjudgeableAt !== null) return null;
  await prisma.instrument.update({
    where: { assetClass_ticker: { assetClass, ticker } },
    data: {
      unjudgeableAt: now,
      unjudgeableNote: `시세를 구하지 못해 판정 불가로 닫힌 카드 ${hardCaps}건`,
    },
  });
  return `${ticker} (${assetClass}): 판정 불가 ${hardCaps}건 — 신규 게시 중단`;
}

/**
 * 다음 시도 시각. **정차(parking)는 이 값이 아니라 deferCount가 표현한다** —
 * null을 "그만"의 뜻으로 쓰면 "아직 한 번도 이월 안 됨"과 구별되지 않는다.
 */
export function nextAttemptAfterDefer(deferCount: number, now: Date): Date {
  // deferCount는 **이번 실패까지 센 값**이다 — 1회차가 눈금 0번을 쓴다
  const idx = Math.min(Math.max(deferCount - 1, 0), DEFER_BACKOFF_MS.length - 1);
  return new Date(now.getTime() + DEFER_BACKOFF_MS[idx]);
}

/**
 * 종목 마스터에서 사라졌나 — 상장폐지의 신호.
 * 마스터는 매일 동기화되고(스케줄러 06:00), 폐지된 종목은 그 목록에서 빠지면서
 * active=false가 된다. 마스터에 아예 없는 경우(레코드 없음)도 같은 뜻이다.
 */
async function isDelisted(
  prisma: PrismaClient,
  assetClass: string,
  ticker: string,
): Promise<boolean> {
  const row = await prisma.instrument.findUnique({
    where: { assetClass_ticker: { assetClass, ticker } },
    select: { active: true },
  });
  return row === null || row.active === false;
}

/**
 * **정지 중에도 상한만은 집행한다** (2026-08-15).
 *
 * 상한은 판정이 아니라 **구매자와의 약속**이다 — "이 시점까지는 결과를 주거나 돈을
 * 돌려준다". 판정을 멈춘 것이 그 약속을 미룰 이유가 되지 못하고, 환불은 고장 난 시세를
 * 쓰지 않으므로 멈출 이유도 없다.
 *
 * ⚠ 이 경로는 시세를 **한 번도 부르지 않는다** — 정지의 목적이 그것이므로.
 * 그래서 원인 구분(DATA / ERROR)을 할 수 없고 `hard-cap:paused`로 따로 적는다.
 * 나중에 "왜 못 쟀나"를 물으면 답이 "우리가 멈춰 두는 동안 시한이 지났다"여야 한다.
 */
async function sweepHardCapped(
  prisma: PrismaClient,
  now: Date,
  /**
   * 어느 사각지대를 쓸는가. 둘 다 **자동 배치의 조회에서 빠져 있어** 상한이 닿지 못하던
   * 카드다 — 원인은 다르지만 구매자 쪽에서 보면 똑같이 "돈이 묶인 채 아무 일도 안 일어남"이다.
   *  · `PAUSED`      운영자가 판정을 멈춰 둔 동안 시한 후 14일이 지난 카드
   *  · `MANUAL_ONLY` 사람만 판정하도록 표시됐는데 아무도 손대지 않은 카드
   */
  scope: 'PAUSED' | 'MANUAL_ONLY',
  assetClass?: AssetClass,
): Promise<BatchSummary> {
  const capBefore = new Date(now.getTime() - JUDGMENT_HARD_CAP_DAYS * 86_400_000);
  const cards = await prisma.predictionCard.findMany({
    where: {
      judgment: null,
      ...(assetClass ? { assetClass } : {}),
      deadline: { lte: capBefore },
      manualJudgmentOnly: scope === 'MANUAL_ONLY',
      report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
    },
    include: {
      report: {
        include: {
          purchases: { where: { escrowStatus: 'HELD' } },
          researcher: { select: { userId: true } },
        },
      },
    },
    orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    take: JUDGE_BATCH_SIZE,
  });

  const summary: BatchSummary = {
    judged: 0,
    deferred: 0,
    failed: 0,
    staleDeferred: [],
    hardCapped: [],
    blockedInstruments: [],
    failures: [],
    providerDown: new Map(),
    disagreed: [],
    emptyRange: new Map(),
    haltedAssetClasses: [],
    cursor: null,
    hasMore: false,
  };

  // **막 걸린 시스템 정지에는 짧은 유예를 준다** (crossCheckRecovery.PAUSE_GRACE_MS).
  //
  // 시한 13.9일째 카드가 있는데 소스 파손으로 정지가 걸리면, 2분 뒤 탐침이 성공해도
  // 그 전에 상한이 돌아 **정상 적중할 수 있었던 카드를 전액 환불로 닫는다.**
  // 유예의 길이는 "자동 회복이 끝까지 갈 수 있는 시간"(62분)으로 못 박혀 있어
  // 구매자 약속은 14일 + 1시간으로 사실상 그대로다. **사람이 건 정지에는 유예가 없다.**
  if (scope === 'PAUSED' && assetClass && (await shouldDelayHardCap(prisma, assetClass, now))) {
    console.log(`${assetClass}: 시스템 정지 직후라 상한 집행을 잠시 미룹니다 (자동 회복 대기)`);
    return summary;
  }

  for (const card of cards) {
    const overdueDays = (now.getTime() - card.deadline.getTime()) / 86_400_000;
    await prisma.$transaction(
      buildJudgmentWrites(
        prisma,
        card,
        {
          result: { outcome: 'UNDECIDABLE' as const, undecidableReason: 'DATA_UNAVAILABLE' as const },
          realizedReturnPct: null,
          score: 0, // 판정 불가는 표본에서 빠진다 — 리서처의 적중률이 깎이지 않는다 (§2.2)
          info: 0, // 증거도 없다 — 규율 래더에 들어가면 안 된다
          dataSource: scope === 'PAUSED' ? 'hard-cap:paused' : 'hard-cap:manual-only',
          audit: {
            hardCap: true,
            cause: scope,
            overdueDays: Math.floor(overdueDays),
            reason:
              scope === 'PAUSED'
                ? `자동 판정이 정지된 동안 시한 후 ${JUDGMENT_HARD_CAP_DAYS}일이 지나 ` +
                  '전액 환불로 닫았습니다 (구매자와의 시한 약속은 정지와 무관합니다)'
                : `사람이 판정하도록 표시된 채 시한 후 ${JUDGMENT_HARD_CAP_DAYS}일이 지나 ` +
                  '전액 환불로 닫았습니다 (수동 큐에 있다는 사실은 시한 약속을 미루지 못합니다)',
            judgedAt: now.toISOString(),
          },
          resolvedBasePrice: null,
        },
        now,
      ),
    );
    summary.judged++;
    const label = scope === 'PAUSED' ? '정지 중' : '수동 큐에서';
    summary.hardCapped.push(`${card.ticker} (${card.id}): ${label} ${Math.floor(overdueDays)}일 초과`);
    console.warn(`${label} 판정 상한 도달 ${card.ticker} (${card.id}) — 판정 불가·전액 환불`);
  }

  // **종목을 막지는 않는다** — 판정 못 한 원인이 그 종목이 아니라 우리 정지이기 때문이다.
  // 여기서 unjudgeableAt을 세우면 멀쩡한 종목이 정지 한 번에 유니버스에서 내려간다
  return summary;
}

export async function judgeAndSettleDueCards(
  prisma: PrismaClient,
  registry: ProviderRegistry,
  now = new Date(),
  /** 자산군 스코프 — 시장별로 마감 직후 그 시장만 판정한다 (없으면 전부) */
  assetClass?: AssetClass,
  /** 이어서 돌 때의 커서 — 직전 회차의 cursor */
  after?: { deadline: Date; id: string },
  /**
   * 배치 락의 자격 검사 (server/batchLock.BatchFence.fence).
   *
   * **모든 쓰기 트랜잭션의 첫 문장으로 들어간다.** 락을 뺏긴 뒤 깨어난 프로세스가
   * 남은 카드를 계속 쓰는 스플릿 브레인을 막는 유일한 장치다 — 회수 판정을 아무리
   * 조여도 "죽었는지 느린지"는 밖에서 구별할 수 없기 때문이다.
   * 없으면(테스트·수동 경로) 검사 없이 돈다.
   */
  fence?: () => Prisma.PrismaPromise<unknown>,
  /**
   * 판정 교차검증용 두 번째 소스 레지스트리 (infra/marketData/createSecondaryRegistry).
   * 없으면 검증 없이 판정하고, 없었다는 사실만 감사 스냅샷에 남는다.
   */
  secondaryRegistry?: ProviderRegistry,
  crossCheckMode: CrossCheckMode = resolveCrossCheckMode(),
): Promise<BatchSummary> {
  // **사람이 멈춰 뒀으면 판정하지 않는다** (server/judgmentPause).
  // 시세 오류로 되돌리는 중에 배치가 깨어나면 같은 고장 난 데이터로 다시 오판정하고,
  // 구매자는 판정이 두 번 뒤집히는 것을 본다.
  //
  // **다만 상한(환불)까지 멈추면 안 된다 (2026-08-15 — 이 정지 스위치가 만든 결함).**
  // 처음에는 여기서 그냥 돌아갔는데, 그러면 정지가 길어지는 동안 시한 후 14일이 지난
  // 카드가 **환불도 못 받고 그대로 묶인다.** 상한은 판정이 아니라 **구매자와의 약속**이다
  // — "이 시점까지는 결과를 주거나 돈을 돌려준다". 판정을 못 하는 것이 그 약속을 미룰
  // 이유가 되지 못하고, 환불은 고장 난 시세를 쓰지 않으므로 멈출 이유도 없다.
  //
  // (정지 기간을 상한에서 빼는 안은 기각했다 — 그건 플랫폼 사정으로 구매자 돈을 더
  //  묶어 두는 것이고, 카드마다 유효 시간이 찢어져 "언제 끝나는가"를 아무도 못 답한다)
  if (await isJudgmentPaused(prisma, assetClass)) {
    return sweepHardCapped(prisma, now, 'PAUSED', assetClass);
  }

  // **수동 큐에 넣어 둔 카드에도 상한은 살아 있어야 한다** (2026-08-15).
  //
  // `manualJudgmentOnly`는 아래 조회에서 통째로 빠지므로, 사람이 손대지 않으면
  // **상한이 영영 닿지 않는다** — 정지 스위치가 만들었던 결함과 정확히 같은 모양이다.
  // 그때 내린 결론이 여기에도 그대로 적용된다: 왜 못 재는지는 구매자 사정이 아니다.
  // 운영자에게는 시한 후 14일이 주어지고(큐 등재 + 매일 알림), 그래도 비면 시스템이
  // 닫는다. 다르게 두면 "판정 불가로 닫힐 수도 없는 카드"라는 칸이 생긴다.
  const manualOnlyCapped = await sweepHardCapped(prisma, now, 'MANUAL_ONLY', assetClass);

  // **정지해 둔 자산군은 스코프 없는 회차에서도 빠져야 한다** (2026-08-15).
  //
  // `isJudgmentPaused(prisma, undefined)`는 **전역 정지만** 본다. 그래서 기동 따라잡기
  // (catchUpOnBoot)와 `npm run batch:judge`가 자산군별 정지를 통째로 무시하고 있었다 —
  // 코인을 멈춰 둬도 **재기동 한 번이면 그대로 판정된다.** 배포가 잦은 시기에는 정지가
  // 사실상 없는 것과 같았고, 교차검증이 스스로 거는 정지가 생기면서 더 나빠졌다
  // (사고가 나서 멈췄는데 그 사고를 고치려고 배포하면 정지가 풀린다).
  //
  // `isJudgmentPaused`의 계약은 그대로 둔다 — 스코프를 준 호출에게는 그 답이 맞고,
  // 거기서 전 자산군을 보게 하면 코인 정지가 국내 판정을 멈추는 반대 사고가 난다.
  // 대신 **조회 대상에서 뺀다.**
  const paused = assetClass ? new Set<AssetClass>() : await pausedAssetClasses(prisma);

  // HELD 구매까지 한 번에 조회 — 카드별 개별 쿼리(N+1) 제거
  const where: Prisma.PredictionCardWhereInput = {
    judgment: null,
    ...(assetClass ? { assetClass } : {}),
    ...(paused.size > 0 ? { assetClass: { notIn: [...paused] } } : {}),
    deadline: { lte: now },
    // **사람만 판정할 카드는 자동 배치가 손대지 않는다.** 되돌린 원인이 시세 소스였다면
    // 같은 소스로 다시 매겨 봐야 같은 오답이 나온다 (PredictionCard.manualJudgmentOnly)
    manualJudgmentOnly: false,
    report: { status: { in: ['PUBLISHED', 'CLOSED'] }, publishedAt: { not: null } },
    // 백오프 — 실패한 카드는 제 시각이 오기 전까지 뜨거운 큐에서 빠져 있는다.
    // **횟수로 빼지는 않는다** (MAX_DEFER_ATTEMPTS 주석 참고) — 시도 횟수는 시간이
    // 아니라서, 재시작이 잦으면 시간이 안 흘렀는데 예산만 소진된다
    AND: [
      { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      // 키셋 커서 — 정렬 키 (deadline, id)보다 뒤에 있는 것만
      ...(after
        ? [
            {
              OR: [
                { deadline: { gt: after.deadline } },
                { deadline: after.deadline, id: { gt: after.id } },
              ],
            },
          ]
        : []),
    ],
  };

  // **한 번에 다 하지 않는다** (JUDGE_BATCH_SIZE 주석 참고). 오래된 시한부터 —
  // 이월이 길어진 카드가 뒤로 밀리면 돈이 묶인 채 계속 밀린다.
  //
  // **커서로 앞으로 나아간다.** 이월된 카드는 Judgment가 안 생겨 다음 조회에도 그대로
  // 잡히므로, 커서 없이 take만 쓰면 오래된 이월 20장이 앞자리를 영구히 차지한다.
  // 정렬에 id를 더한 이유도 같다 — 시한이 같은 카드가 여럿이면 순서가 흔들려
  // 커서가 어떤 카드를 건너뛸 수 있다.
  const dueCards = await prisma.predictionCard.findMany({
    where,
    include: {
      report: {
        include: {
          purchases: { where: { escrowStatus: 'HELD' } },
          researcher: { select: { userId: true } },
        },
      },
    },
    orderBy: [{ deadline: 'asc' }, { id: 'asc' }],
    take: JUDGE_BATCH_SIZE,
  });

  // 같은 종목의 만기 카드가 여러 장이면 조회는 한 번이면 된다 (memoRegistry)
  const quotes = memoizeRegistry(registry);

  const summary: BatchSummary = {
    // 수동 큐 상한 처리분을 이어받는다 — 같은 회차의 같은 종류(판정 불가·전액 환불)라
    // 따로 보고하면 운영자가 한 회차를 두 번 읽어야 한다
    judged: manualOnlyCapped.judged,
    deferred: 0,
    failed: 0,
    staleDeferred: [],
    hardCapped: [...manualOnlyCapped.hardCapped],
    blockedInstruments: [],
    failures: [],
    providerDown: new Map(),
    disagreed: [],
    emptyRange: new Map(),
    haltedAssetClasses: [],
    cursor:
      dueCards.length > 0
        ? {
            deadline: dueCards[dueCards.length - 1].deadline,
            id: dueCards[dueCards.length - 1].id,
          }
        : null,
    hasMore: dueCards.length === JUDGE_BATCH_SIZE,
  };

  /** 자산군별 불일치 수 — 정지 판단의 분자 (분모는 dueCards의 자산군별 개수) */
  const disagreedByClass = new Map<AssetClass, number>();
  /** 불일치를 낸 카드 — 정지 시 탐침의 표적이 된다 (티커별로 고르게 뽑는다) */
  const disagreedCardIds = new Map<AssetClass, { id: string; ticker: string }[]>();

  /** 소스별 빈 배열 집계 — 없으면 만들어 준다 */
  const statFor = (assetClassOfCard: string): EmptyRangeStat => {
    const src = registry[assetClassOfCard as AssetClass]?.sourceId ?? assetClassOfCard;
    let stat = summary.emptyRange.get(src);
    if (!stat) {
      stat = { attempted: 0, empty: 0, stuckTickers: [] };
      summary.emptyRange.set(src, stat);
    }
    return stat;
  };

  for (const card of dueCards) {
    // 시도한 카드를 먼저 센다 — **분모가 없으면 빈 배열 몇 건이 사고인지 알 수 없다.**
    // 시도 전에 세는 이유는 중간에 어디로 빠져나가도 분모가 빠지지 않게 하려는 것
    statFor(card.assetClass).attempted++;

    // 정산이 걸린 자리라 권리 사건 반영이 더 중요하다 — 옛 눈금으로 채점하면
    // 점수·환불이 한꺼번에 틀린다 (도달 판정 배치와 같은 함수를 쓴다)
    let unappliedAction: string | null = null;
    try {
      const rebased = await rebaseIfAdjusted(prisma, quotes, card, now);
      if (rebased?.applied) {
        card.basePrice = rebased.basePrice;
        card.targetValue = rebased.targetValue;
        console.log(`권리 사건 반영 ${card.ticker} (${card.id}): ${rebased.note}`);
      } else if (rebased) {
        unappliedAction = rebased.note;
        console.error(`권리 사건 감지·미반영 ${card.ticker} (${card.id}): ${rebased.note}`);
      }
    } catch (e) {
      console.error(`권리 사건 점검 실패 ${card.ticker} (${card.id}):`, e);
    }

    const judgeable = toJudgeableCard(card, card.report.publishedAt!);

    try {
      // **눈금이 어긋난 것을 알면서 채점하지 않는다** (2026-08-15).
      //
      // 감지는 됐는데 교차검증(원주가 대조)이 통과하지 못한 상태다. 지금까지는 이걸
      // 로그로만 남기고 **옛 기준가 그대로 판정했다** — 2:1 분할이면 −50% 폭락으로
      // 읽혀 실패 판정이 나가고, 환불이 집행되면 리서처가 이의를 제기해도 돌려줄
      // 돈이 없다. 우리가 이미 "뭔가 어긋났다"를 알고 있는 자리에서 나는 사고다.
      //
      // 이월하면 백오프 → 7일 뒤 운영자 큐 → 그래도 안 풀리면 14일 상한(전액 환불)로
      // 이어진다. 사람이 권리 사건을 **미리 알고 있어야** 작동하는 도구를 따로 만드는
      // 것보다, 모르는 채로도 돈이 잘못 나가지 않는 쪽이 먼저다
      if (unappliedAction) {
        throw new JudgmentDeferredError(
          `권리 사건이 감지됐지만 반영하지 못했습니다 (${unappliedAction}) — ` +
            `기준가 눈금이 어긋난 채로는 판정하지 않습니다`,
          'DATA_NOT_AVAILABLE',
        );
      }

      const { result, audit, resolvedBasePrice } = await runJudgmentFromRegistry(
        judgeable,
        quotes,
        now,
        secondaryRegistry,
        crossCheckMode,
      );
      const basePrice = resolvedBasePrice ?? card.basePrice;

      const { realizedReturnPct, score, info } = scoreJudgedCard({
        direction: card.direction as Direction,
        targetType: card.targetType as TargetType,
        targetValue: card.targetValue,
        confidence: card.confidence,
        assetClass: card.assetClass as AssetClass,
        // 게시 시점에 잰 종목 변동성 — p₀의 입력 (없으면 자산군 σ̄로 폴백)
        sigmaDaily: card.sigmaDaily,
        basePrice,
        settledPrice: result.settledPrice,
        // p₀(무정보 도달 확률)의 입력 — 게시된 사양(게시→시한)의 기간
        horizonDays:
          (card.deadline.getTime() - card.report.publishedAt!.getTime()) / 86_400_000,
        outcome: result.outcome,
      });

      const writes = buildJudgmentWrites(
        prisma,
        card,
        { result, realizedReturnPct, score, info, dataSource: audit.dataSource, audit, resolvedBasePrice },
        now,
      );
      await prisma.$transaction(fence ? [fence(), ...writes] : writes);
      summary.judged++;
    } catch (e) {
      // **예상 밖 오류도 이월과 같은 절차를 밟는다.**
      //
      // 예전에는 `else`에서 로그만 찍고 끝냈는데, 그게 **가장 조용한 구멍**이었다:
      //  · 백오프가 안 걸려 매 회차 같은 카드를 다시 부른다 (KIS 호출을 영원히 갉아먹는다)
      //  · 상한(Hard Cap)이 이월 경로에만 있어 **에스크로가 영원히 안 풀린다**
      //  · 알림 경로가 없어 콘솔에만 남는다 — 이월은 정차 큐, 상한은 전용 알림이 있는데
      //    **버그로 죽는 카드만 아무도 모른다**
      // 판정이 안 된다는 사실은 원인과 무관하게 같으므로 절차(백오프·상한·큐)도 같다.
      // 다르게 다루는 것은 **알림 문구**뿐인데, 그 갈래가 셋이다 (2026-08-15):
      //   이월   → 아무것도 안 해도 된다 (다음 회차가 다시 본다)
      //   공급자 → 소스 상태를 본다 (KIS 공지·업비트 상태 페이지). 기다리면 낫는다
      //   버그   → 로그를 보고 코드를 고친다. 기다려도 안 낫는다
      const providerDown = e instanceof ProviderUnavailableError;
      const deferred = e instanceof JudgmentDeferredError;
      const message = e instanceof Error ? e.message : String(e);

      // ── 두 소스가 다른 답을 냈다 → **곧장 사람에게** (2026-08-15) ──────────
      //
      // 아래의 이월·상한 사다리를 타지 않는다. 그 사다리는 "기다리면 데이터가 온다"를
      // 전제로 백오프 → 7일 큐 → 14일 환불로 이어지는데, 여기서는 **기다림이 아무것도
      // 바꾸지 않는다.** 다음 회차도 같은 두 값을 받아 같은 두 결론을 낸다. 그 길을
      // 그대로 태우면 결말이 "판정 불가·전액 환불"로 정해져 있고, 그건 **맞혔을지도
      // 모르는 리서처에게서 대금을 뺏는** 방향이다.
      //
      // 상장폐지 판별보다 먼저 오는 이유: 여기까지 왔다는 것은 **두 소스 모두 시세를
      // 줬다**는 뜻이다. 시세 결측을 전제로 하는 판별을 돌릴 이유가 없다.
      //
      // 상한은 여전히 살아 있다 — 수동 큐로 옮겨도 sweepHardCapped('MANUAL_ONLY')가
      // 14일에 닫는다. 사람에게 넘기는 것과 구매자를 무기한 기다리게 하는 것은 다르다.
      if (e instanceof JudgmentDisagreementError) {
        await prisma.predictionCard.update({
          where: { id: card.id },
          data: { manualJudgmentOnly: true },
        });
        summary.disagreed.push(`${card.ticker} (${card.id}): ${message}`);
        // 정지 판단은 **자산군마다 따로** 한다 — 한 통에 담으면 깨진 자산군이
        // 멀쩡한 자산군에 희석돼 문턱에 못 닿는다
        const cls = card.assetClass as AssetClass;
        disagreedByClass.set(cls, (disagreedByClass.get(cls) ?? 0) + 1);
        // 정지가 걸리면 탐침이 **이 카드들**을 먼저 본다 (crossCheckRecovery.setProbeTargets)
        disagreedCardIds.set(cls, [
          ...(disagreedCardIds.get(cls) ?? []),
          { id: card.id, ticker: card.ticker },
        ]);
        console.error(`시세 소스 간 판정 불일치 ${card.ticker} (${card.id}):`, message);
        continue;
      }

      {
        // **상장폐지 판별** — 시세가 안 오는 것만으로는 폐지인지 일시적 결측인지 모른다.
        // 그런데 종목 마스터에서 사라진 종목은 다음 동기화에서 active=false가 되므로,
        // 두 사실이 겹치면(마스터에서 빠짐 + 시세 없음) 폐지로 본다.
        //
        // 둘 다 요구하는 이유: 우리가 유니버스에서 뺀 종목(ETF 필터 등)도 active=false가
        // 되는데 시세는 멀쩡히 나온다. 그때 폐지로 처리하면 멀쩡한 카드가 환불된다.
        // 반대로 시세만 없는 경우는 휴장·일시 장애일 수 있어 이월이 맞다.
        // 코드 오류는 종목에 대해 아무것도 말해 주지 않는다 — 폐지 판별은 시세 결측일 때만
        if (deferred && (await isDelisted(prisma, card.assetClass, card.ticker))) {
          const result = {
            outcome: 'UNDECIDABLE' as const,
            undecidableReason: 'DELISTED' as const,
          };
          await prisma.$transaction(
            buildJudgmentWrites(
              prisma,
              card,
              {
                result,
                realizedReturnPct: null,
                score: 0, // 판정 불가는 표본에서 빠진다 (§2.2)
                info: 0, // 증거도 없다 — 규율 래더에 들어가면 안 된다
                dataSource: 'instrument-master',
                audit: {
                  delisted: true,
                  reason: '종목 마스터에서 사라졌고 시세도 조회되지 않습니다',
                  deferMessage: message,
                  judgedAt: now.toISOString(),
                },
                resolvedBasePrice: null,
              },
              now,
            ),
          );
          summary.judged++;
          console.log(`상장폐지 판정 불가 ${card.ticker} (${card.id}) — 전액 환불`);
          continue;
        }
        // **시한이 한참 지나도록 못 구하면 시스템이 닫는다** (전액 환불).
        // 시세 소스 장애는 플랫폼 사정인데 그 대가를 구매자가 무기한 기다림으로 치를
        // 이유가 없다. 7일에 운영자 큐로 올라가고, 그래도 안 되면 여기서 끝낸다
        const overdueDays = (now.getTime() - card.deadline.getTime()) / 86_400_000;
        if (overdueDays >= JUDGMENT_HARD_CAP_DAYS) {
          await prisma.$transaction(
            buildJudgmentWrites(
              prisma,
              card,
              {
                result: {
                  outcome: 'UNDECIDABLE' as const,
                  undecidableReason: 'DATA_UNAVAILABLE' as const,
                },
                realizedReturnPct: null,
                score: 0, // 판정 불가는 표본에서 빠진다 (§2.2)
                info: 0, // 증거도 없다 — 규율 래더에 들어가면 안 된다
                dataSource: deferred ? 'hard-cap' : 'hard-cap:error',
                audit: {
                  hardCap: true,
                  // **원인을 감사 기록에 남긴다.** 구매자에게는 똑같이 "판정 불가·전액
                  // 환불"이지만, 나중에 "왜 못 쟀나"를 물으면 답이 달라야 한다 —
                  // 시세를 못 구한 것과 우리 코드가 죽은 것은 다른 이야기다
                  cause: deferred ? 'DATA' : 'ERROR',
                  overdueDays: Math.floor(overdueDays),
                  deferCount: card.deferCount,
                  reason: deferred
                    ? `시한 후 ${JUDGMENT_HARD_CAP_DAYS}일이 지나도록 시세를 구하지 못했습니다`
                    : `시한 후 ${JUDGMENT_HARD_CAP_DAYS}일이 지나도록 판정이 오류로 실패했습니다`,
                  lastDeferMessage: message,
                  judgedAt: now.toISOString(),
                },
                resolvedBasePrice: null,
              },
              now,
            ),
          );
          summary.judged++;
          summary.hardCapped.push(`${card.ticker} (${card.id}): ${Math.floor(overdueDays)}일 초과`);
          console.warn(`판정 상한 도달 ${card.ticker} (${card.id}) — 판정 불가·전액 환불`);
          // **원인을 그대로 두면 다음 카드도 똑같이 끝난다.** 같은 종목이 반복해서
          // 상한에 걸리면 그 종목의 신규 게시를 막는다 (진행 중인 카드·돈은 그대로)
          const blocked = await blockUnjudgeableInstrument(
            prisma,
            card.assetClass,
            card.ticker,
            now,
          );
          if (blocked) {
            summary.blockedInstruments.push(blocked);
            console.warn(`신규 게시 중단 ${blocked}`);
          }
          continue;
        }

        // **다음 시도를 뒤로 민다.** 이 한 줄이 없으면 실패하는 카드가 매 회차
        // 앞자리를 차지해 KIS 호출을 갉아먹고 뒤의 멀쩡한 카드까지 느려진다
        const deferCount = card.deferCount + 1;
        await prisma.predictionCard.update({
          where: { id: card.id },
          data: { deferCount, nextAttemptAt: nextAttemptAfterDefer(deferCount, now) },
        });

        if (deferred) {
          summary.deferred++;
          // **200 OK + 빈 배열은 따로 센다.** 예외가 안 나서 다른 어떤 감시에도 안 걸리는
          // 유일한 실패 모양이라, 여기서 세지 않으면 영원히 "평범한 이월"로 보인다
          if ((e as JudgmentDeferredError).reason === 'EMPTY_RANGE') {
            const stat = statFor(card.assetClass);
            stat.empty++;
            // 같은 종목이 반복해서 비면 소스 전체가 아니라 **그 종목**의 문제다
            // (티커 변경·상장폐지 직전). 비율 알림이 못 잡는 갈래라 따로 모은다
            if (deferCount >= EMPTY_RANGE_STREAK && !stat.stuckTickers.includes(card.ticker)) {
              stat.stuckTickers.push(card.ticker);
            }
          }
          const staleDays = (now.getTime() - card.deadline.getTime()) / 86_400_000;
          // 자동 재시도를 다 쓴 카드는 **날짜와 무관하게** 사람에게 넘긴다 —
          // 시한 직후에 연달아 실패한 카드가 7일을 기다릴 이유가 없다
          if (deferCount >= MAX_DEFER_ATTEMPTS || staleDays >= STALE_DEFER_DAYS) {
            summary.staleDeferred.push(`${card.ticker} (${card.id}, ${deferCount}회 이월): ${message}`);
          }
        } else if (providerDown) {
          // **소스별로 한 줄**로 센다 — 종목 목록은 길기만 하고 아무것도 안 말한다
          summary.failed++;
          const src = (e as ProviderUnavailableError).sourceId;
          summary.providerDown.set(src, (summary.providerDown.get(src) ?? 0) + 1);
          console.error(`시세 공급자 응답 없음 ${card.ticker} (${card.id}):`, message);
        } else {
          summary.failed++;
          console.error(`판정 실패 ${card.ticker} (${card.id}):`, e);
          // **첫 번째부터 알린다.** 이월은 정차 큐가, 상한은 전용 알림이 받아 주지만
          // 예상 밖 오류에는 **다른 발견 경로가 없다.** 그리고 이건 데이터가 아니라
          // 코드 문제라 시간이 지난다고 저절로 낫지 않는다 — 사람이 봐야 한다.
          // 소음 걱정은 백오프가 덜어 준다(같은 카드는 1시간·6시간·하루 간격으로만 다시 온다)
          summary.failures.push(`${card.ticker} (${card.id}, ${deferCount}회): ${message}`);
        }
      }
    }
  }

  // ── 불일치가 무더기면 이 자산군을 세운다 (shouldHaltOnDisagreement) ──────
  //
  // 여기까지 오는 동안 불일치 카드는 이미 하나씩 수동 큐로 갔다. 그런데 **무더기로
  // 났다면 문제는 카드가 아니라 소스**다 — 그리고 그 소스로 판정한 나머지 카드는
  // 합의했다는 이유로 안전한 것이 아니라, 그저 목표선을 사이에 두지 않았을 뿐이다.
  //
  // 정지는 **다음 회차부터** 듣는다(이번 회차의 판정은 이미 나갔다). 그래도 이 자리가
  // 맞다: 다음 회차를 세우지 않으면 같은 소스로 다음 20장이 그대로 나간다.
  //
  // **자산군별로 나눠 센다.** 스코프 없는 회차(기동 따라잡기·수동 배치)는 여러 자산군을
  // 한 번에 도는데, 거기서 하나의 비율로 판단하면 **깨진 자산군이 멀쩡한 자산군에
  // 희석돼 정지가 안 걸린다** — 코인 8장이 다 갈려도 전체 100장 중 8%다.
  const attemptedByClass = new Map<AssetClass, number>();
  for (const c of dueCards) {
    const k = c.assetClass as AssetClass;
    attemptedByClass.set(k, (attemptedByClass.get(k) ?? 0) + 1);
  }
  for (const [cls, attempted] of attemptedByClass) {
    const disagreed = disagreedByClass.get(cls) ?? 0;
    if (!shouldHaltOnDisagreement(disagreed, attempted)) continue;
    await setJudgmentPause(
      prisma,
      {
        scope: cls,
        paused: true,
        // **사람이 아니라 시스템이 세웠다**는 사실이 기록에 남아야 한다 — 해제할 때
        // "누가 왜 멈췄나"의 답이 "아무도"면 원인을 못 찾고, 무엇보다 이 표식이
        // **자동 해제 자격의 유일한 기준**이다 (crossCheckRecovery)
        operatorUserId: SYSTEM_PAUSE_ACTOR,
        reason:
          `시세 소스 간 판정 불일치 ${disagreed}/${attempted}건 — ` +
          '한 소스가 깨졌을 가능성이 높아 자동 판정을 정지했습니다',
      },
      now,
    );
    // **이번 사고의 탐침은 0회부터 센다** — 실패 횟수를 사고 너머로 이어 두면
    // 지난 사고에서 6회를 채운 자산군이 오늘 멈추는 순간 탐침 한 번 없이
    // "자동 재개 포기"로 떨어진다 (crossCheckRecovery.resetProbeState)
    // **탐침이 봐야 할 것은 깨진 카드다** — 티커별로 고르게 뽑는다(selectProbeTargets).
    // 안 적어 두면 탐침은 아무 카드나 5장을 보게 되고, 파손이 특정 티커에만 있으면
    // 멀쩡한 5장이 통과해 정지가 풀린다
    await beginRecovery(prisma, cls, disagreedCardIds.get(cls) ?? [], now);
    summary.haltedAssetClasses.push(cls);
    console.error(`[P0] ${cls} 자동 판정 정지 — 불일치 ${disagreed}/${attempted}건`);
  }

  return summary;
}
