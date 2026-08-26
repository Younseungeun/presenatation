import type { Finding, RiskCategory, ScreeningInput } from '@/domain/compliance';
import { RISK_CATEGORY_LABEL } from '@/domain/compliance';
import { buildStudentText, isStudentLabel } from '@/domain/studentText';

// 학생 모델 사이드카 클라이언트 — 웹에서 Python 사이드카(localhost)를 부르는 포트.
//
// **설계 원칙 셋** (5·6차 검토 확정):
//
// ① **공급자가 없으면 완전히 꺼진다.** 환경 변수가 없으면 null을 돌려주고 한 줄도 돌지
//    않는다 — 임베딩 어댑터와 같은 패턴이다. 기능이 조용히 반쯤 켜지는 것이 가장 나쁘다.
//
// ② **그림자 모드에서는 어떤 실패도 게시를 막지 않는다.** 사이드카가 죽어 있든 느리든
//    타임아웃이 나든, 호출자는 빈 결과를 받고 게시는 그대로 진행된다. 학생은 아직
//    처리 권한이 없으므로 그 실패는 "판정 없음"이지 "판정 불가"가 아니다.
//
// ③ **지문이 다르면 소견을 쓰지 않는다.** 학습과 서빙이 다른 토크나이저를 쓰면 예외가
//    나는 게 아니라 조용히 틀린 답이 나온다. 그래서 값을 믿지 않고 지문을 대조한다 —
//    임베딩 벡터에 모델 식별자를 함께 저장하는 것과 같은 계열의 방어다.

/** @근거 설계 — 사이드카는 localhost라 정상이면 수 ms다. 이보다 느리면 죽은 것으로 본다 */
const TIMEOUT_MS = 2_000;

export interface StudentHealth {
  ok: boolean;
  /** 가중치 없이 토크나이저만 올라간 상태 — 소견을 내지 않는다 */
  stub: boolean;
  tokenizerSha: string;
  /** 학습 시점에 기록된 지문. 스텁 모드에서는 없다 */
  trainedTokenizerSha?: string;
  /**
   * 적재한 **가중치**의 지문. 파일 이름은 늘 `model.onnx`라 이 값이 유일한 신원이다.
   * 9차에 이것이 없어서, 죽지 않은 옛 프로세스가 서빙하는 옛 모델을 새 모델로 착각해
   * 그 성적을 보고했다.
   */
  modelSha?: string;
  /** 적재 뒤 디스크의 가중치가 바뀌었다 = 이 프로세스는 옛 모델을 서빙 중이다 */
  modelStale?: boolean;
  /**
   * **기동 시 파이프라인 스모크 테스트를 통과했는가** (9차 G-1 · 11차 K-3).
   *
   * 내보내기가 구워 둔 입력·정답을 지금 이 스택으로 통과시킨 결과다. 잡는 것은
   * **라벨 순서 · 토크나이저 · 출력 차원 · 그래프 결합성**이고, **가중치 훼손은
   * 아니다** — 그쪽은 `modelSha`가 전담한다(돌연변이 시험 실측: 로짓 대조만으로는
   * 비트 훼손의 90%가 통과했다).
   */
  ready?: boolean;
  /** 준비되지 않았다면 왜인지. 이유 없는 거부는 진단을 지운다 */
  readyDetail?: string;
  labels: string[];
  /**
   * 모델의 이름 — 사이드카가 config.json 에서 읽어 준다 (회신 13호). `.env` 의
   * STUDENT_MODEL_TAG 는 사람이 타이핑한 **주장**이고 이것이 파일과 한 몸인 **사실**이다.
   * 2026-08-22 에 .env 가 옛 이름을 들고 있던 채 지문은 맞는 상태가 실제로 있었다.
   * 옛 사이드카·config 에는 없으므로 선택 필드.
   */
  run?: string;
  /**
   * 짧고 안정된 **이름** (config.json 의 name, 예: IRIS.v5) — 도장·화면용. `run` 은 회차 기록이라
   * 이름 칸으로 쓰면 대장 문장이 소견에 박힌다 (회신 14호). 공백·@·/ 없음 (train.py 가 거절).
   */
  name?: string;
}

export interface StudentOutput {
  findings: Finding[];
  latencyMs: number;
  /** 토크나이저 대조용 — 스텁 모드에서도 채워진다 */
  tokenCount: number;
  tokenIdsHead: number[];
}

export interface StudentClient {
  /** 그림자 기록에 남길 판정 주체. 임계값까지 박는다 — 임계값이 다르면 다른 판정기다 */
  readonly reviewerId: string;
  health(): Promise<StudentHealth | null>;
  screen(input: ScreeningInput): Promise<StudentOutput | null>;
  /**
   * **실집행에 쓸 수 있는 상태인가.** 소견이 게시를 보류시키기 시작하면 반드시 거쳐야 한다.
   *
   * 그림자 모드에서는 지문이 어긋난 기록을 버리면 그만이었지만(결측), 라이브에서는
   * 그 소견이 **실제로 리서처의 게시를 멈춘다.** 학습과 서빙의 토크나이저가 다르면
   * 예외가 아니라 조용히 틀린 답이 나오므로, 틀린 답으로 남의 게시를 막는 일이 없어야 한다.
   *
   * 결과를 캐시한다 — 리포트마다 /health를 부르면 호출이 두 배가 된다. 성공은 프로세스
   * 수명 동안, 실패는 짧게만 기억한다(사이드카를 다시 띄우면 배포 없이 돌아와야 한다).
   */
  usable(): Promise<boolean>;
  /**
   * **캐시를 버리고 다시 잰다** — 주기 점검·화면 열기 전용 (2026-08-23).
   *
   * `usable()` 의 캐시는 집행 경로(리포트마다)의 최적화라 그대로 두어야 하고, 감시
   * 경로만 매번 새로 재야 한다. 없으면 5분 주기 점검이 **첫 회만 진짜**가 된다.
   * 선택 항목인 이유: 캐시가 없는 구현(시험 목)에는 `usable()` 과 같은 일이다.
   */
  recheck?(): Promise<boolean>;
  /**
   * **화면·문자가 읽는 출근 상태** (2026-08-23 창업자 확정 B안) — `usable()` 과 다르다.
   *
   * `usable()` 은 집행이라 첫 실패에서 곧장 false 다(못 미더운 모델에게 판정을 맡기느니
   * 보류가 낫다). 반면 **결근 선언은 두 번 연속 실패해야** 한다 — 호출 한 번의 2초
   * 초과로 문자가 나갔다 5분 뒤 복귀 문자가 또 나간 일이 실제로 있었고, 그런 문자가
   * 반복되면 진짜 결근에도 폰을 안 본다. 그 사이는 `pendingFailure` 로 따로 말한다.
   *
   * 선택 항목인 이유: 연속 실패를 세지 않는 구현(시험 목)에는 잰 값이 곧 상태다.
   */
  attendance?(): { ok: boolean; pendingFailure: boolean };
  /**
   * **왜 못 쓰는지 — 전부** (2026-08-23). 마지막 `usable()` 이 남긴 목록, 쓸 수 있으면 빈 배열.
   *
   * 화면이 사유를 따로 계산하면 핑 결과를 모른 채 상태 플래그만 보게 되어, 원인이
   * 무엇이든 같은 문장 하나로 뭉개진다. 사유는 잰 쪽이 안다.
   *
   * 선택 항목인 이유: 사유를 남기지 않는 구현(시험 목)도 정당하다 — 그때는 호출자가
   * `describeUnavailability(health)` 로 되돌아간다.
   */
  failureReasons?(): UnavailableReason[];
  /**
   * **가용 상태가 바뀌었으면 한 번만 알려 준다** (9차 검토 G-2, 상태 엣지 탐지).
   *
   * 사이드카 장애는 이 설계에서 **게시 중단이 아니라 검수 약화**로 나타난다 —
   * 게시는 계속되고 리서처도 구매자도 차이를 못 느끼고 패러프레이즈만 안 잡힌다.
   * **조용한 실패**라 발견 경로가 없다.
   *
   * 그렇다고 실패할 때마다 알리면 재기동 중 1분마다 울려 경보 피로가 된다. 울려야
   * 하는 것은 상태가 아니라 **상태의 변화**다: 붙어 있다가 끊긴 순간, 끊겼다가
   * 돌아온 순간. 그 사이의 침묵은 정보다.
   *
   * 전이를 **여기서** 잡는 이유는 상태가 여기 살기 때문이다(gate 캐시). 알림은 prisma가
   * 있는 층에서 보내야 하므로, 감지와 통지를 나누고 이 함수가 그 사이를 잇는다.
   * **1회용이다** — 두 번 부르면 두 번째는 null이라 같은 전이로 두 번 울리지 않는다.
   */
  consumeAvailabilityChange(): { to: boolean; detail: string } | null;
}

/**
 * 학생 검수를 **어디까지 쓸 것인가** (8차 E-6 확정).
 * - `off`: 한 줄도 돌지 않는다
 * - `shadow`: 판단하되 기록만 — 게시에 영향 없음
 * - `live`: 소견이 1차 단계에 합류해 **보류를 유발한다.** 거절 권한은 없다(항상 WARN)
 *
 * 기본값이 `live`인 근거: ① 사이드카 URL을 설정하는 것 자체가 이미 명시적 선택이고
 * ② 채택선을 넘었으며(8차 C-1: 합산 오탐이 규칙 단독과 동일) ③ 학생에게는 거절 권한이
 * 없어 최악이 "운영자 큐가 길어지는 것"이다. 무엇보다 **출시 시점에 그림자로 두면
 * 가장 위험한 시기에 가장 약한 검수**가 된다(규칙 단독은 패러프레이즈 0%).
 * 되돌리는 것은 배포가 아니라 환경 변수여야 한다 — 그래서 값으로 뒀다.
 */
export type StudentMode = 'off' | 'shadow' | 'live';

export function studentMode(env = process.env): StudentMode {
  if (!env.STUDENT_SIDECAR_URL) return 'off';
  const raw = env.STUDENT_MODE;
  return raw === 'shadow' || raw === 'off' ? raw : 'live';
}

/**
 * **졸업한 라벨만 소견으로 쓴다** (8차 확정 — 라벨별 졸업의 첫 사례).
 *
 * 모델은 8차원을 전부 내지만, 그중 쓸 만한 것과 아닌 것이 실측으로 갈렸다:
 * 문장 7유형은 t=0.5에서 **오탐을 한 건도 더하지 않으면서** 패러프레이즈를 66.7% 잡는데,
 * `CARD_MISMATCH`는 **정상 문서 34건을 전부 걸었다**(risk_heavy 오탐 100%). 그 항목은
 * "리스크를 길게 다루지만 결론은 카드와 같은" 성실한 리포트라, 배포하면 잘 쓴 리서처가
 * 가장 많이 막힌다 — coherenceCorpus.ts가 "이 코퍼스의 유일한 합격 조건에 가깝다"고
 * 적어 둔 바로 그 자리다.
 *
 * **임계값을 라벨별로 나누는 것과 다르다.** 그쪽은 128건으로 8개의 값을 고르는 것이라
 * 검증셋 과적합이지만(3차 F-1), 이쪽이 정하는 것은 값이 아니라 **켤지 말지**다.
 * 그리고 그 판단은 스윕이 아니라 "오탐 100%"라는 하나의 관측에서 나온다.
 *
 * ⚠ **CARD_MISMATCH의 제외는 "아직"이 아니라 "구조적"이다** (8차 E-5 확정).
 * 데이터를 더 넣어도 이 구조로는 풀리지 않는다:
 *   ① 문장 7유형은 **국소적**이다 — 한 문장의 어휘와 그 둘레만 보면 판단이 선다.
 *   ② CARD_MISMATCH는 **전역적**이다 — 문서 첫머리(카드)와 끝머리(결론)를 함께 봐야 한다.
 *   ③ 그런데 기반 모델의 상한이 512토큰이라 **결론부가 잘린다**(꽉 찬 리포트 약 660토큰).
 *      판단할 근거를 못 본 채 답하는 것이므로, 성적이 오르면 그건 다른 것을 외운 것이다.
 * 이 문제는 512토큰 문장 분류기의 책임 밖이고, 풀려면 NLI 교차 인코더 같은 다른 구조가
 * 필요하다(compliance-screening 로드맵). **여기에 이름을 다시 넣지 마십시오** —
 * 넣으면 성실하게 리스크를 쓴 리서처가 가장 많이 막힌다.
 */
export const DEFAULT_ENABLED_LABELS: readonly RiskCategory[] = [
  'PROFIT_GUARANTEE',
  'PRIVATE_INFO',
  'RUMOR',
  'SOLICIT_CONTACT',
  'UNSUPPORTED_CLAIM',
  'RISK_INDUCEMENT',
  'SCREENING_EVASION',
  // CARD_MISMATCH — **영구 제외** (구조적으로 불가, 위 주석 ①②③)
];

/** 사이드카 응답 → Finding[]. 심각도는 항상 WARN — 학생에게는 거절 권한이 없다 */
function toFindings(raw: unknown, enabled: ReadonlySet<string>): Finding[] {
  const list = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item): Finding[] => {
    const f = item as { category?: string; score?: number };
    if (!f.category || !isStudentLabel(f.category as RiskCategory)) return [];
    if (!enabled.has(f.category)) return []; // 미졸업 라벨은 소견으로 나가지 않는다
    const category = f.category as RiskCategory;
    return [
      {
        category,
        // 학생 소견은 어떤 성적이 나와도 보류까지다 (자동 거절은 결정적 규칙에만)
        severity: 'WARN',
        quote: '',
        // **확신 %를 문장에 싣지 않는다** (Q8(b) · 관리자 앱 2회차 A-1 발견).
        // reason 은 리서처에게 그대로 나가는 문장이라, 숫자를 실으면 리서처가 재제출을
        // 반복하며 임계값을 이진 탐색한다. 숫자는 confidence 로만 — 관리자 화면 전용
        reason: `${RISK_CATEGORY_LABEL[category]} 정황 (IRIS)`,
        // 'ai'가 아니라 'student' — 오탐을 고치는 방법이 달라서다 (FindingSource 주석)
        source: 'student',
        // 값은 값의 자리에 (Q7) — 화면이 reason 을 정규식으로 파싱하게 하지 않는다
        confidence: f.score ?? 0,
      },
    ];
  });
}

/**
 * 시맨틱 핑 문장 (22차 Y-1(b)) — 핑에 침묵하는 모델은 개별 미탐이 아니라 추론이 죽은 것.
 *
 * ── 문장은 감으로 고르면 안 된다 (2026-08-21 실측으로 배움) ──────────
 * 첫 문장("원금 100% 보장 상품입니다. 절대 손실이 나지 않습니다")은 채택선을 통과한
 * 진짜 모델이 침묵했다(PG 0.24) — "절대 손실이 나지 **않습니다**"가 부정형 위반이라
 * 이 스레드가 3회차를 쓴 최난도 유형이었고, "교과서적 위반"이라는 감이 모델의 난이도
 * 지형과 달랐다. **"핑 실패 = 뇌사"도 gap 17형이다**: 건강한 특화 모델이 고정 문장에
 * 침묵할 수 있다. 그래서 둘을 함께 둔다:
 *   ① 문장은 후보 실측으로 고른다 — 현행 문장 PG 0.856 (부정형 없음, 학습셋에 미포함
 *      검증: 핑만 외운 뇌사 방지)
 *   ② **채택 게이트가 핑 통과를 조건 ④로 보증한다** (eval:student) — 채택된 모델은
 *      반드시 핑을 잡으므로, 운영 중 핑 실패는 "모델 특성"이 아니라 진짜 이상 신호다
 * ⚠ 학습셋에 이 문장을 그대로 넣지 말 것 — 핑만 외운 뇌사 모델이 핑을 통과하게 된다.
 */
export interface SemanticPing {
  /** 이 문항이 시험하는 라벨 (정상 문항은 짝이 되는 라벨) */
  label: 'PROFIT_GUARANTEE' | 'PRIVATE_INFO' | 'RUMOR' | 'SOLICIT_CONTACT';
  kind: 'violation' | 'normal';
  input: ScreeningInput;
}

/**
 * @근거 시뮬 — 정상 핑의 상한. 진짜 정상 자문 산문도 라벨 최대값이 0.17~0.25 로
 *   나온다(2026-08-22 r5 실측 4문장: 0.242/0.231/0.249/0.171). 25차에 제안했던
 *   0.15 는 이 실측으로 자체 반증돼 0.30 으로 확정(26차 CC-4). 발작(상수 출력)
 *   감지에는 위반 하한 0.85 와의 격차 0.55 로 충분하다.
 */
export const NORMAL_PING_CEILING = 0.3;

/**
 * **학생이 왜 실집행에서 빠졌는지를 한 줄로.**
 *
 * `usable()` 이 쓰던 문구를 그대로 꺼낸 순수 함수다. 두 벌로 적으면 갈리므로 한 곳에 둔다 —
 * 여기서 만든 문구가 **장애 알림**(complianceService)과 **운영 계기판**(student-valve) 양쪽에
 * 같은 값으로 간다.
 *
 * 계기판이 이걸 필요로 하는 이유: 알림은 **상태가 바뀌는 순간 한 번만** 나가는데, 고치러 오는
 * 사람이 보는 곳은 알림함이 아니라 화면이다. 사유가 화면에 없으면 "결근"만 남고, 실제로
 * 2026-08-22 에 토크나이저 지문이 갈렸을 때 화면만 봐서는 원인을 찾을 수 없었다.
 *
 * 순서는 `usable()` 의 검사 순서와 같다. 다만 **토크나이저 대조를 핑보다 앞에 둔다** —
 * 원래 코드와 결과가 같으면서(지문이 어긋나면 `healthOk` 가 false 라 핑까지 가지 못하고,
 * 핑을 돈 경우엔 이미 지문이 맞다) `pingDetail` 을 모르는 호출자도 쓸 수 있게 된다.
 * 그래서 마지막 가지는 **소거법**이다: 상태 넷이 전부 멀쩡한데 못 쓴다면 남는 것은 핑뿐이다.
 */
export function describeUnavailability(
  health: StudentHealth | null,
  pingDetail?: string,
): string {
  // **목록의 첫 항목이 이 문장이다** — 두 벌로 적으면 갈린다 (2026-08-23)
  return listUnavailability(health, pingDetail)[0].sentence;
}

/**
 * **못 쓰는 이유를 전부 열거한다** (2026-08-23 창업자 지시 — 검수 규칙의 층 배지처럼).
 *
 * `describeUnavailability` 는 **첫 이유 하나**만 돌려준다. 알림 한 줄에는 그것이 맞지만
 * 계기판에서는 부족하다: 지문도 어긋나고 카나리아도 깨진 상태에서 앞의 하나만 고치면
 * 여전히 결근인데 화면은 그 사실을 미리 말해 주지 않는다. 고칠 것이 몇 개인지가
 * **고치러 가기 전에** 보여야 한다.
 *
 * 검사끼리 독립이라 그냥 다 담으면 된다. **핑만 예외**로, 다른 넷이 전부 멀쩡할 때만
 * 담는다 — `usable()` 이 상태 검사에서 걸리면 핑을 아예 돌지 않으므로, 함께 적으면
 * 재지도 않은 항목을 실패로 세우는 것이 된다.
 */
export interface UnavailableReason {
  code: 'OFFLINE' | 'STUB' | 'STALE' | 'CANARY' | 'SHA' | 'PING';
  /** 배지에 쓰는 짧은 이름 — 어디를 고칠지가 이 한 마디로 갈려야 한다 */
  label: string;
  /** 사람이 읽는 한 문장 — 알림과 상세 화면이 그대로 쓴다 */
  sentence: string;
}

export function listUnavailability(
  health: StudentHealth | null,
  pingDetail?: string,
): UnavailableReason[] {
  if (!health) {
    return [{ code: 'OFFLINE', label: '연결 불가', sentence: '사이드카에 연결할 수 없습니다' }];
  }
  const out: UnavailableReason[] = [];
  if (health.stub) {
    out.push({ code: 'STUB', label: '스텁 모드', sentence: '스텁 모드 — 가중치 없음' });
  }
  if (health.modelStale) {
    out.push({
      code: 'STALE',
      label: '가중치 교체됨',
      sentence: '적재 뒤 가중치 파일이 바뀌었습니다 (옛 프로세스일 수 있습니다)',
    });
  }
  if (health.ready === false) {
    out.push({
      code: 'CANARY',
      label: '기동 카나리아',
      sentence: `카나리아 실패: ${health.readyDetail ?? '사유 없음'}`,
    });
  }
  if (health.trainedTokenizerSha && health.trainedTokenizerSha !== health.tokenizerSha) {
    out.push({
      code: 'SHA',
      label: '지문 불일치',
      // 두 값을 함께 적는다 — "불일치"만으로는 어느 쪽을 고쳐야 하는지 알 수 없다
      sentence: `토크나이저 지문 불일치 — 학습 ${health.trainedTokenizerSha} ≠ 서빙 ${health.tokenizerSha}`,
    });
  }
  if (out.length === 0) {
    out.push({
      code: 'PING',
      label: '시맨틱 핑',
      sentence: `시맨틱 핑 실패 — ${pingDetail || '상태는 정상인데 고정 문항이 어긋납니다'}`,
    });
  }
  return out;
}

function pingInput(content: string): ScreeningInput {
  return { title: '', summary: '', content, assetClass: 'KR_EQUITY', assetName: '', direction: 'UP' };
}

/**
 * N-핑 8문항 (26차 CC-4 확정) — 치명 라벨 4과목 × (위반 1 + 정상 1).
 *
 * 1문항 핑은 전면 뇌사만 갈랐다. 부분 뇌사(특정 라벨 헤드만 사멸)와 발작(무엇을
 * 넣어도 고점을 뱉는 상수 출력)은 위반·정상 대비쌍이 있어야 갈린다:
 *   - 위반 문항 침묵 → 그 라벨의 뇌사 의심
 *   - **정상 문항에서 켜진 라벨이 NORMAL_PING_CEILING 초과 → 발작 의심** (정상까지
 *     고점이면 위반 핑 통과는 지능의 증거가 아니다 — 26차 gap 17형)
 *
 * 자격 요건 (25차 확정, 채택 시마다 재실측): 위반 핑은 해당 라벨 실측 **0.85 이상**,
 * 정상 핑은 전 라벨 **0.30 이하**로 여유 통과하는 문장만. 경계 대역(0.6~0.7) 문장을
 * 핑에 쓰면 정상적인 경계 재조정 학습에도 오경보가 난다 — 경계 감시는 핑이 아니라
 * 회귀셋의 몫이다.
 *
 * 실측 (2026-08-25 재선정, 32차 II-3 판정 — scripts/selectPings.ts, buildStudentText 경로 = usable 과 동일):
 * 선정 기준은 **교집합** — r5(a0eaa12a)와 다음 후보 P1-A(a0e3d04a)가 **모두** 위반 0.85 이상.
 *   위반  r5 0.839 / 0.859 / 0.862 / 0.865 · P1-A 0.903 / 0.947 / 0.966 / 0.940
 *   정상 최대 라벨  r5 0.242 / 0.231 / 0.249 / 0.171 · P1-A 0.282 / 0.116 / 0.084 / 0.071
 * PRIVATE 위반 문장은 이때 교체됐다(구: "제 지인이 그 회사 IR팀에…" r5 0.834 — 미달 자격 박탈).
 * ⚠ **PG 는 교집합이 비어 있다** — 명백한 위반 9문장 실측에서 r5 의 PG 최고점이 정확히
 *   현행 문장(0.839)이고 나머지는 0.50~0.83. 문장의 자격 문제가 아니라 **r5 PG 헤드의
 *   상한**이다(110M 은 전부 0.90+). 현행 문장 유지 — r5 대에는 선정선 0.85 가 PG 에서
 *   달성 불가능하다는 사실 자체를 기록한다(33차 보고). 라이브 usable() 의 위반 핑 집행은
 *   t=0.7 이라 여유 0.14 로 영향 없음.
 * ⚠ 이 문장들을 학습셋에 넣지 말 것 (check:ping 이 감시) — 핑만 외운 모델이 통과한다.
 */
export const SEMANTIC_PINGS: readonly SemanticPing[] = [
  {
    label: 'PROFIT_GUARANTEE',
    kind: 'violation',
    input: pingInput('이 종목은 무조건 오릅니다. 손해 보시면 제가 다 물어드립니다.'),
  },
  {
    label: 'PROFIT_GUARANTEE',
    kind: 'normal',
    input: pingInput(
      '반도체 업황은 재고 조정 국면을 지나고 있으며, 수요 회복 시점은 불확실합니다. 분할 매수로 접근하되 손절 기준을 지키시기 바랍니다.',
    ),
  },
  {
    label: 'PRIVATE_INFO',
    kind: 'violation',
    input: pingInput('어제 그 회사 재무팀 친구한테 아직 공시 전인 수주 계약 내용을 직접 들었습니다.'),
  },
  {
    label: 'PRIVATE_INFO',
    kind: 'normal',
    input: pingInput(
      '이번 실적은 시장 예상치에 부합했습니다. 다만 환율 변동에 따라 수익성이 달라질 수 있어 보수적 접근을 권합니다.',
    ),
  },
  {
    label: 'RUMOR',
    kind: 'violation',
    input: pingInput(
      '아직 기사 안 난 얘긴데, 다음 주에 대형 호재 공시가 터진다는 소문이 파다합니다. 미리 담으세요.',
    ),
  },
  {
    label: 'RUMOR',
    kind: 'normal',
    input: pingInput(
      '동사의 매출은 전년 대비 소폭 증가했으나 영업이익률은 하락했습니다. 원가 부담이 지속될 것으로 보입니다.',
    ),
  },
  {
    label: 'SOLICIT_CONTACT',
    kind: 'violation',
    input: pingInput(
      '텔레그램으로 문의 주세요. 아이디는 프로필에 있습니다. 일대일 상담으로 매수가를 찍어드립니다.',
    ),
  },
  {
    label: 'SOLICIT_CONTACT',
    kind: 'normal',
    input: pingInput(
      '금리 인하 시점에 대한 시장의 기대가 엇갈리고 있습니다. 채권 비중 조절은 각자의 위험 성향에 맞추시기 바랍니다.',
    ),
  },
];

class HttpStudentClient implements StudentClient {
  /**
   * 사이드카가 알려 준 모델 이름 (config.json 의 run). health() 가 한 번 성공하면 채워진다.
   * 그 전에는 .env 태그가 자리를 메운다 — 그래서 reviewerId 는 "호출 전에는 주장, 호출 뒤에는
   * 사실"이다. 실집행 경로는 usable() 이 health() 를 먼저 부르므로 소견에 박히는 값은 사실 쪽이다.
   */
  private resolvedName: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly threshold: number,
    private readonly modelTag: string,
    private readonly enabled: ReadonlySet<string>,
  ) {}

  /**
   * 판정 주체 표기. 졸업 라벨 수까지 박는다 — 켜진 라벨이 다르면 다른 판정기이고, 그림자
   * 기록을 나중에 견줄 때 그 사실이 값에 남아 있어야 한다.
   *
   * 이름 자리는 **파일이 들고 온 run** 이 우선이다 (회신 13호): 2026-08-22 에 .env 태그가
   * 옛 이름(koelectra-synth-v2)인 채 지문은 a0eaa12a 로 맞아, 화면 세 줄 중 한 줄만 틀린
   * 상태가 실제로 있었다. 대조를 하나 더 만드는 대신 이름의 출처를 파일로 옮긴다.
   * 임계값만 설정에 남는다 — 그건 파일의 성질이 아니라 우리가 고른 값이다.
   */
  get reviewerId(): string {
    return `student:${this.resolvedName ?? this.modelTag}@t${this.threshold}/L${this.enabled.size}`;
  }

  /** 지문 대조 결과 캐시. 성공은 영구, 실패는 짧게만 — 사이드카 재기동이 배포 없이 살아나야 한다 */
  private gate: { ok: boolean; until: number } | null = null;
  /** 마지막 usable() 이 남긴 결근 사유 — 걸쇠 캐시와 같은 수명 */
  private lastFailure: UnavailableReason[] | null = null;

  /** @근거 설계 — 실패를 기억하는 시간. 사이드카를 다시 띄운 뒤 1분이면 회복된다 */
  private static readonly GATE_RETRY_MS = 60_000;

  /**
   * **연속 실패 횟수 — 결근을 선언하기까지 몇 번 헛걸음했나** (2026-08-23 창업자 확정 B안).
   *
   * 실제로 겪은 일이다: 04:49 에 `The operation was aborted due to timeout` 하나로
   * 결근 문자가 나가고 04:54 에 근무 중 문자가 또 나갔다. 사이드카는 멀쩡했고
   * 원인은 그 순간 CPU 를 다 쓰던 시험이었다. **호출 한 번의 2초 초과가 사람을
   * 깨우면 안 된다** — 그런 문자가 몇 번 반복되면 진짜 결근에도 폰을 안 본다.
   *
   * 그래서 **집행과 선언을 가른다**:
   * · `usable()` = 집행. 첫 실패에서 곧장 false — 못 미더운 모델에게 판정을 맡기느니
   *   보류가 낫다. 여기서 기다리면 그 5분 동안 IRIS 가 소견을 낸다.
   * · `attendanceOk()` = 선언(문자·화면). **두 번 연속** 실패해야 결근이다.
   *   주기가 5분이라 진짜 결근은 늦어도 10분 안에 잡히고, 그 10분이 곧 문턱이다
   *   (`CANARY_STALE_MS` 를 주기 2배로 맞춘 것과 같은 잣대).
   */
  private consecutiveFailures = 0;

  /** @근거 설계 — 한 번은 헛걸음일 수 있고 두 번은 아니다. 주기 5분 × 2 = 문턱 10분 */
  private static readonly FAILURES_TO_DECLARE_ABSENT = 2;

  /** 마지막으로 **알린** 상태. 아직 한 번도 안 알렸으면 null */
  private announced: boolean | null = null;
  /** 아직 안 꺼내 간 전이 */
  private pendingChange: { to: boolean; detail: string } | null = null;

  consumeAvailabilityChange(): { to: boolean; detail: string } | null {
    const c = this.pendingChange;
    this.pendingChange = null;
    return c;
  }

  /** 상태가 **바뀐 경우에만** 전이를 쌓는다. 첫 관측은 전이가 아니다 */
  private noteAvailability(ok: boolean, detail: string): void {
    if (this.announced === ok) return;
    // 첫 관측이 성공이면 알리지 않는다 — 정상 기동은 사건이 아니다.
    // 첫 관측이 실패면 알린다: 켜 두었는데 처음부터 못 쓰는 상태가 가장 조용한 실패다.
    if (this.announced !== null || !ok) {
      this.pendingChange = { to: ok, detail };
    }
    this.announced = ok;
  }

  /**
   * **걸쇠 기억을 버리고 다시 잰다** — 주기 점검·화면 열기 전용 (2026-08-23 창업자 지시).
   *
   * `usable()` 은 성공을 프로세스 수명 내내 캐시한다. 리포트마다 `/health` 를 부르지
   * 않으려는 설계고 **집행 경로에서는 그게 맞다.** 문제는 그 캐시가 감시까지 덮는다는
   * 것이다: 스케줄러가 5분마다 `usable()` 을 불러도 **첫 회만 진짜 점검**이고 나머지는
   * 기억을 되뇐다. 화면을 열 때도 마찬가지라, 어제 확인된 "출근"이 오늘도 그대로 뜬다.
   *
   * 그래서 캐시를 **없애는 것이 아니라 우회로를 낸다** — 집행은 빠르게, 감시는 정확하게.
   * 비용은 `/health` 1 + 시맨틱 핑 8 = 9회(localhost, 1초 미만)라 **부르는 자리를 세는
   * 것이 중요하다**: 5분 주기와 화면 열기까지다. 폴링마다 부르면 안 된다.
   */
  async recheck(): Promise<boolean> {
    this.gate = null;
    return this.usable();
  }

  async usable(): Promise<boolean> {
    if (this.gate && (this.gate.ok || Date.now() < this.gate.until)) return this.gate.ok;
    const health = await this.health();
    const healthOk =
      !!health?.ok &&
      !health.stub && // 가중치 없이 토크나이저만 — 소견을 낼 수 없다
      // **적재 뒤 가중치 파일이 바뀌었으면 쓰지 않는다** (9차). 새 모델을 내보냈는데
      // 옛 프로세스가 죽지 않아 포트를 쥐고 있는 상태 — 이름도 토크나이저도 그대로라
      // 이 검사가 없으면 아무 신호도 없이 옛 모델이 판정한다.
      !health.modelStale &&
      // **카나리아를 통과하지 못했으면 쓰지 않는다** (9차 G-1) — 서빙 스택이
      // 내보내기가 본 것을 재현하지 못하는 상태다
      health.ready !== false &&
      // **지문이 다르면 쓰지 않는다.** 학습과 서빙의 토크나이저가 다르면 예외가 아니라
      // 조용히 틀린 답이 나오고, 라이브에서 그 답은 남의 게시를 멈춘다.
      (!health.trainedTokenizerSha || health.trainedTokenizerSha === health.tokenizerSha);

    // **시맨틱 핑 — 상태가 아니라 지능을 확인한다** (22차 Y-1(b) 검토 확정).
    //
    // 위 검사는 전부 상태 플래그다. "학생 뇌사"(가중치가 깨져 무엇을 넣어도 소견 0)와
    // "학생 정상"은 HTTP 200 아래에서 완벽히 같은 값이다 — 22차가 지목한 gap 17형
    // 함정이고, 실측으로 확인했다(studentSemanticPing.test.ts: 뇌사 모의 클라이언트가
    // 옛 usable 을 통과해 밸브가 닫혔다). 그래서 상태 검사를 다 통과한 뒤 고정 위반
    // 문장 하나를 실제로 추론시켜, 기대 라벨(PROFIT_GUARANTEE)을 뱉는지 본다.
    // 결과는 상태 검사와 같은 캐시를 탄다 — 성공은 프로세스 수명, 실패는 짧게.
    // 사유는 `pingDetail` 하나로 남긴다 — 비어 있지 않다는 것이 곧 핑 실패다
    let pingDetail = '';
    let ok = healthOk;
    if (healthOk) {
      // 켜진 라벨의 문항만 시험한다 — 꺼진 라벨의 침묵은 뇌사가 아니라 설정이다
      const pings = SEMANTIC_PINGS.filter((p) => this.enabled.has(p.label));
      if (pings.length === 0) {
        // 핑 라벨이 전부 꺼진 구성에서는 지능 확인이 불가능하다 — 막지는 않되 소리는 낸다
        console.error(
          '시맨틱 핑 생략 — 핑 라벨이 STUDENT_ENABLED_LABELS 에 하나도 없어 ' +
            '추론 무결성을 확인할 수 없습니다 (뇌사 상태를 못 가릅니다).',
        );
      }
      for (const p of pings) {
        if (p.kind === 'violation') {
          // 핑은 **모델**을 재는 것이라 창 분할 어댑터를 타지 않는다 — 단일 호출.
          // (창을 타면 3문장짜리 핑 문항이 호출 3회가 되고, 어댑터 버그가 핑 결과를 가린다)
          const raw = await this.call<{ findings: unknown }>('/screen', {
            text: buildStudentText(p.input),
            threshold: this.threshold,
          });
          const caught = raw
            ? toFindings(raw, this.enabled).some((f) => f.category === p.label)
            : false;
          if (!caught) {
            pingDetail = `${p.label} 위반 문항 침묵 (부분 뇌사 의심)`;
            ok = false;
            break;
          }
        } else {
          // 정상 문항은 낮은 임계값으로 원점수를 본다 — 발작(상수 출력) 모델은 위반
          // 핑을 전부 통과하므로, 정상 문장에서 고점이 나오는지가 유일한 감별식이다
          // (26차 CC-4 — "평균 격차" 판정식은 부분 발작을 평균이 가려 기각됨)
          const raw = await this.call<{ findings?: { category: string; score: number }[] }>(
            '/screen',
            { text: buildStudentText(p.input), threshold: NORMAL_PING_CEILING },
          );
          if (!raw) {
            pingDetail = '정상 문항 핑 호출 실패';
            ok = false;
            break;
          }
          const seized = (raw.findings ?? []).find(
            (f) => this.enabled.has(f.category) && f.score > NORMAL_PING_CEILING,
          );
          if (seized) {
            pingDetail =
              `정상 문장에 ${seized.category} ${seized.score.toFixed(2)} — 발작 의심 ` +
              `(상한 ${NORMAL_PING_CEILING})`;
            ok = false;
            break;
          }
        }
      }
    }
    if (health?.modelStale) {
      console.error(
        '학생 모델이 낡았습니다 — 적재 뒤 가중치 파일이 바뀌었습니다. ' +
          '사이드카를 다시 띄우십시오(옛 프로세스가 살아 있을 수 있습니다).',
      );
    }
    if (!ok && health && !health.stub && health.trainedTokenizerSha !== health.tokenizerSha) {
      console.error(
        `학생 모델 토크나이저 지문 불일치 — 실집행에서 제외합니다. ` +
          `학습 ${health.trainedTokenizerSha} ≠ 서빙 ${health.tokenizerSha}`,
      );
    }
    if (health && health.ready === false) {
      console.error(`학생 모델 카나리아 실패 — 실집행에서 제외합니다: ${health.readyDetail}`);
    }
    // **왜 못 쓰는지를 붙잡아 둔다** (2026-08-23 창업자 지시).
    //
    // `pingDetail` 은 이 함수 안에서만 살아 있었다. 계기판 라우트는 `usable()` 의
    // 참·거짓만 받고 사유는 `describeUnavailability(health)` 로 **다시 계산**했는데,
    // 그쪽에는 핑 결과가 없으니 상태 플래그가 전부 정상인 경우 남는 답이 하나뿐이라
    // 늘 "상태는 정상인데 고정 문항이 어긋납니다"만 떴다. 실제로 그 문장 때문에
    // 모델이 죽은 것인지·늦은 것인지·지문이 어긋난 것인지 화면으로 구별할 수 없었다
    // (고칠 곳이 전혀 다른 셋이다). 사유를 **한 번 계산해 여기 둔다.**
    this.lastFailure = ok ? null : listUnavailability(health, pingDetail);
    this.consecutiveFailures = ok ? 0 : this.consecutiveFailures + 1;
    // **알리는 것은 확정된 상태뿐이다** — 첫 실패는 아직 사건이 아니다(위 주석 참고).
    // 회복은 반대로 즉시 알린다: 한 번이라도 응답하면 그건 헛걸음이 아니라 사실이다.
    if (ok || this.declaredAbsent()) {
      this.noteAvailability(ok, ok ? '사이드카 정상' : this.lastFailure![0].sentence);
    }
    this.gate = { ok, until: Date.now() + HttpStudentClient.GATE_RETRY_MS };
    return ok;
  }

  /** 연속 실패가 문턱에 닿았나 — 결근 선언의 유일한 조건 */
  private declaredAbsent(): boolean {
    return this.consecutiveFailures >= HttpStudentClient.FAILURES_TO_DECLARE_ABSENT;
  }

  /**
   * **화면·문자가 읽는 출근 상태** — 집행이 읽는 `usable()` 과 다르다.
   *
   * 첫 실패에서 이미 `usable()` 은 false 라 게시는 보류로 간다(안전). 다만 화면에
   * "결근 중"을 띄우고 문자를 보내는 것은 **두 번째 실패부터**다. 그 사이 상태는
   * `pendingFailure` 로 따로 말한다 — 근무 중이라고 잘라 말하면 화면이 거짓말이 되고,
   * 결근이라고 하면 헛걸음 하나로 사람을 깨운다. **모르는 것은 모른다고 적는다.**
   */
  attendance(): { ok: boolean; pendingFailure: boolean } {
    return {
      ok: !this.declaredAbsent(),
      pendingFailure: this.consecutiveFailures > 0 && !this.declaredAbsent(),
    };
  }

  /**
   * 마지막 `usable()` 이 남긴 결근 사유 — 쓸 수 있으면 null.
   *
   * 걸쇠 캐시와 같은 수명이다: 캐시된 답을 돌려주는 동안에는 그때의 사유가 그대로
   * 유효하고, 다시 재는 순간 함께 갱신된다.
   */
  failureReasons(): UnavailableReason[] {
    return this.lastFailure ?? [];
  }

  /** 모든 실패를 삼키고 null을 돌려준다 — 호출자가 게시를 막지 않게 하기 위해 */
  private async call<T>(path: string, body?: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (e) {
      // 로그만 남긴다. 그림자 모드에서 사이드카 장애는 사건이 아니라 결측이다
      console.error('IRIS 사이드카 호출 실패:', (e as Error).message);
      return null;
    }
  }

  async health(): Promise<StudentHealth | null> {
    const raw = await this.call<{
      ok: boolean;
      stub: boolean;
      tokenizer_sha: string;
      trained_tokenizer_sha?: string | null;
      model_sha?: string | null;
      model_stale?: boolean;
      ready?: boolean;
      ready_detail?: string;
      labels?: string[];
      run?: string | null;
      name?: string | null;
    }>('/health');
    if (!raw) return null;
    // 파일이 들고 온 이름을 기억한다 — 이후 reviewerId 는 .env 가 아니라 이 값을 쓴다.
    // run(회차 기록)은 쓰지 않는다: 구분자(@ /)가 들어올 수 있는 자유 문장이라 도장이 모호해진다
    if (raw.name) this.resolvedName = raw.name;
    return {
      name: raw.name ?? undefined,
      run: raw.run ?? undefined,
      ok: raw.ok,
      stub: raw.stub,
      tokenizerSha: raw.tokenizer_sha,
      trainedTokenizerSha: raw.trained_tokenizer_sha ?? undefined,
      modelSha: raw.model_sha ?? undefined,
      modelStale: raw.model_stale ?? false,
      // 옛 사이드카(필드 없음)는 준비된 것으로 본다 — 이 필드가 없다는 것 자체가
      // 배포 불일치라 model_stale·지문 대조가 이미 그 상황을 잡는다
      ready: raw.ready ?? true,
      readyDetail: raw.ready_detail,
      labels: raw.labels ?? [],
    };
  }

  async screen(input: ScreeningInput): Promise<StudentOutput | null> {
    // 입력 직렬화는 buildStudentText 한 곳에만 있다 — 사이드카가 자기 방식으로 조립하면
    // 학습 때와 다른 문자열이 들어가고, 그건 예외 없이 조용히 틀린 답을 만든다
    const raw = await this.call<{
      findings: unknown;
      latency_ms: number;
      token_count: number;
      token_ids_head: number[];
      stub: boolean;
    }>('/screen', { text: buildStudentText(input), threshold: this.threshold });
    if (!raw) {
      // **"출근했다"는 기억을 지운다** (2026-08-23 창업자 지적).
      //
      // 걸쇠는 성공을 **프로세스 수명 내내** 캐시한다(`usable()` 첫 줄) — 리포트마다
      // /health 를 부르지 않으려는 설계고, 그 자체는 맞다. 문제는 첫 확인 뒤에 IRIS 가
      // 죽었을 때다: 게시는 `studentFailed` 가 잡아 보류로 돌리지만(complianceService),
      // 걸쇠는 계속 참이라 **계기판이 초록으로 "출근 중"을 띄우고 장애 알림도 안 나간다.**
      // 보류 카드만 쌓이고 원인이 화면에 없는 상태 — 고치러 갈 곳을 표시가 가린다.
      //
      // 실제로 물었는데 대답이 없었다는 것은 헬스체크보다 **강한 증거**다. 그 증거로
      // 캐시를 무효화하면 다음 `usable()` 이 다시 재고, `noteAvailability` 가 전이를
      // 잡아 알림이 나간다. 창 호출(아래)의 실패는 여기 넣지 않는다 — 그쪽은 주석대로
      // 결측으로 감내하는 자리고, 통짜 호출이 이미 성공했으면 창구는 열려 있다.
      this.gate = null;
      return null;
    }
    const whole: StudentOutput = {
      // 스텁 모드(가중치 없음)에서는 사이드카가 빈 배열을 준다 — 배관만 검증되는 상태
      findings: toFindings(raw, this.enabled),
      latencyMs: raw.latency_ms,
      tokenCount: raw.token_count,
      tokenIdsHead: raw.token_ids_head ?? [],
    };

    // ── 창 분할 채점 (27차 DD-1 ① — 토큰 희석·절단 방어) ─────────────
    //
    // 실측(2026-08-22, r5): 단독으로 0.77~0.85 잡히던 위반 5문장이 정상 공시 산문
    // 400토큰 뒤에 붙자 **전부 임계 밑으로 침몰**(잔존율 13~46%). 그리고 리포트
    // 상한(제목100+요약300+본문1,000자)은 512토큰을 넘을 수 있어 끝의 위반은
    // 희석이 아니라 **절단**된다(1,740자 실측: token_count 512 고정, PG 0.23).
    //
    // 방어: 문서를 2문장 창(보폭 1)으로 잘라 각 창을 따로 추론하고 라벨별 최대값을
    // 통짜 결과에 병합한다. 실측 회복: 침몰 5건 중 4건이 0.75~0.85로 복귀, 나머지
    // 1건(두 문장에 걸친 전언+유도)이 2문장 창의 존재 이유다.
    // 짧은 입력(문장 3개 미만 — 채점지·핑·DART 문항)은 창이 통짜와 같으므로 그대로.
    // 학습 분포와도 맞는다: 학습 예시가 정확히 "카드 + 짧은 본문" 형태다.
    const sentences = splitForWindows(input);
    if (sentences.length >= WINDOW_TRIGGER_SENTENCES) {
      const best = new Map<string, Finding>();
      for (const f of whole.findings) best.set(f.category, f);
      const windows: string[] = [];
      // 상한은 측정 스크립트가 env 로 바꿔 볼 수 있다 (30차 먼저 재야 할 것 ②). 운영 기본값은 상수
      const maxWindows = Number(process.env.STUDENT_MAX_WINDOWS ?? MAX_WINDOWS) || MAX_WINDOWS;
      for (let i = 0; i < sentences.length - 1 && windows.length < maxWindows; i += 1) {
        windows.push(`${sentences[i]} ${sentences[i + 1]}`);
      }
      let latency = whole.latencyMs;
      // 창 전용 임계값 — 창을 N번 이동하며 N번 판정하므로 문장 임계값을 그대로 쓰면
      // 문서 오탐이 부푼다(다중 비교). 실측(WINDOW_THRESHOLD 주석)으로 0.8 에서 0%.
      const wt = Math.max(this.threshold, WINDOW_THRESHOLD);
      const merge = (raw: unknown) => {
        for (const f of toFindings(raw, this.enabled)) {
          const prev = best.get(f.category);
          if (!prev || (f.confidence ?? 0) > (prev.confidence ?? 0)) best.set(f.category, f);
        }
      };
      // ── 창 묶음 전송 (32차 II-4 (a)) — 창들을 /screen_batch 로 묶어 보낸다 ──
      // 낱개 HTTP 순차 호출은 110M fp32 에서 문서당 1.3~1.5초(예산 1,500ms 경계)였고
      // 그중 창당 ~45ms 가 순수 왕복·파싱이다. 서버는 안에서 낱개로 돌므로(/screen 과
      // 같은 계산) 판정이 갈라질 자리가 없다 — 빨라지는 것은 왕복 횟수뿐이다.
      // STUDENT_WINDOW_BATCH=0 은 측정용 강제 우회.
      // **한 번에 8창까지만** — 서버 낱개 실행은 창 수에 선형(창당 ~80ms·110M)이라 창 40개를
      // 한 요청에 담으면 그 요청 하나가 TIMEOUT_MS(2s)를 넘고, 타임아웃 → 낱개 폴백이
      // 서버에 버려진 계산과 겹쳐 지연이 오히려 배가 된다 (2026-08-25 실측).
      let batched = false;
      if ((process.env.STUDENT_WINDOW_BATCH ?? '1') !== '0') {
        batched = true;
        for (let at = 0; at < windows.length && batched; at += WINDOW_BATCH_SIZE) {
          const chunk = windows.slice(at, at + WINDOW_BATCH_SIZE);
          const br = await this.call<{ results: { findings: unknown }[]; latency_ms: number }>('/screen_batch', {
            texts: chunk.map((w) => buildStudentText({ ...input, title: '', summary: '', content: w })),
            threshold: wt,
          });
          if (!br || !Array.isArray(br.results)) {
            batched = false; // 첫 조각부터 실패(옛 사이드카 404 포함)면 낱개 경로가 전체를 다시 맡는다
            break;
          }
          latency += br.latency_ms;
          for (const one of br.results) merge(one);
        }
      }
      if (!batched) {
        // 배치 실패(엔드포인트 없는 옛 사이드카 404 포함)는 낱개 경로로 되돌아간다 —
        // 조용히 창 방어를 끄는 것이 최악이다. 배치·낱개가 함께 죽으면 그때가 결측이다.
        for (const w of windows) {
          const wr = await this.call<{ findings: unknown; latency_ms: number }>('/screen', {
            text: buildStudentText({ ...input, title: '', summary: '', content: w }),
            threshold: wt,
          });
          if (!wr) continue; // 창 하나의 실패는 결측 — 문서 전체를 죽이지 않는다
          latency += wr.latency_ms;
          merge(wr);
        }
      }
      return { ...whole, latencyMs: latency, findings: [...best.values()] };
    }
    return whole;
  }
}

/**
 * @근거 시뮬 — 창 크기 2문장: 1문장 창은 두 문장에 걸친 위반("…입수했습니다. 내일
 *   대량 매수 들어옵니다")을 0.548로 놓쳤다(단독 0.770). 발동 문턱 3문장: 그 밑은
 *   창과 통짜가 같아 호출만 는다. 상한 40창: 본문 1,000자 상한에서 나올 수 없는
 *   수 — 폭주 입력 방어.
 */
const WINDOW_TRIGGER_SENTENCES = 3;
const MAX_WINDOWS = 40;
/**
 * @근거 실측 (2026-08-25, P1-A 110M · i7-9700F) — 묶음의 이득은 HTTP 왕복 제거뿐이다
 *   (요청당 ~45ms — ONNX 패딩 배치는 오히려 창당 20~40ms 손해라 서버도 낱개로 돈다).
 *   8창 조각 ≈ 최악 ~1s 로 TIMEOUT_MS(2s) 안에 들어온다. 조각이 크면 요청 하나가
 *   타임아웃을 넘어, 낱개 폴백과 서버에 버려진 계산이 겹치는 최악 경로가 열린다.
 */
const WINDOW_BATCH_SIZE = 8;

/**
 * @근거 시뮬 — 구두점이 없는 글(공시체 "…있습니다 …합니다")은 1단계에서 통째로 한 조각이
 *   된다. 2026-08-22 실측: 그 상태로는 창이 문서 전체가 되어 희석 방어가 0 이었다.
 *   이 길이를 넘는 조각만 종결어미(다/요/까/죠 + 공백)로 다시 자른다 — 짧은 조각까지
 *   어미로 자르면 "…하다 보니"류 중간 분절이 는다.
 */
const LONG_FRAGMENT_CHARS = 80;

/**
 * @근거 시뮬 — scripts/probeWindowDocFp.ts (2026-08-22, r5, DART 정상 유사 문서 150건):
 *   창 2·보폭 1에서 문서 오탐 t=0.7 → 5.3% / t=0.8 → 0%. 같은 창에서 희석 위반 회복은
 *   t=0.7 3/5, t=0.8 2/5(0.839·0.827). λ=4 아래에서 문서 오탐 5%는 못 받으므로 0.8.
 *   창 3은 t=0.7 오탐 0.67%지만 회복이 0/5(창이 길수록 위반이 다시 희석된다).
 *   28차 EE-2 판정(창 전용 t 0.8~0.85)의 하단값 — 0.85는 회복이 1/5로 준다.
 */
const WINDOW_THRESHOLD = 0.8;

/** 창 후보 문장 — 제목·요약도 문장이다 (거기 숨긴 위반도 같은 대접). 측정 스크립트와 공유 */
export function splitForWindows(input: Pick<ScreeningInput, 'title' | 'summary' | 'content'>): string[] {
  const joined = [input.title, input.summary, input.content].filter(Boolean).join(' ');
  const out: string[] = [];
  for (const piece of joined.split(/(?<=[.!?…])\s+|\n+/)) {
    const p = piece.trim();
    if (p.length <= LONG_FRAGMENT_CHARS) {
      out.push(p);
      continue;
    }
    // 2단계 — 구두점 없이 이어진 긴 조각은 종결어미 뒤 공백에서 자른다
    for (const q of p.split(/(?<=[다요까죠])\s+/)) out.push(q.trim());
  }
  return out.filter((s) => s.length >= 5);
}

/**
 * STUDENT_SIDECAR_URL이 없으면 null — 학생 검수가 **한 줄도 돌지 않는다.**
 *
 * 임계값은 단일이다 (3차 F-1): 손코퍼스 128건으로 라벨별 8차원을 스윕하면 검증셋에
 * 과적합된다. 라벨별로 푸는 것은 미달일 때의 플랜 B이고, 그때도 8개가 아니라
 * 위험 성격 4단계로 묶는다.
 */
const clients = new Map<string, StudentClient>();

export function createStudentClientFromEnv(env = process.env): StudentClient | null {
  const url = env.STUDENT_SIDECAR_URL;
  if (!url) return null;
  const threshold = Number(env.STUDENT_THRESHOLD ?? '0.5');
  const labels = env.STUDENT_ENABLED_LABELS
    ? env.STUDENT_ENABLED_LABELS.split(',').map((s) => s.trim()).filter(Boolean)
    : [...DEFAULT_ENABLED_LABELS];
  const tag = env.STUDENT_MODEL_TAG ?? 'unknown';
  // **설정이 같으면 같은 객체를 돌려준다.** usable()의 지문 대조 캐시가 인스턴스에
  // 붙어 있어서, 요청마다 새로 만들면 캐시가 매번 버려지고 리포트마다 /health를 부른다.
  const key = `${url}|${threshold}|${tag}|${labels.join(',')}`;
  const cached = clients.get(key);
  if (cached) return cached;
  const client = new HttpStudentClient(
    url.replace(/\/$/, ''),
    Number.isFinite(threshold) ? threshold : 0.5,
    tag,
    new Set(labels),
  );
  clients.set(key, client);
  return client;
}
