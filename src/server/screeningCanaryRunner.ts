import type { PrismaClient } from '@prisma/client';
import {
  CANARY_PHRASE,
  SCREENING_CANARY,
  canaryInput,
  checkCanary,
  type CanaryFailure,
} from '@/domain/screeningCanary';
import type { RiskCategory } from '@/domain/compliance';
import { collectAutoScreenFindings } from './complianceService';
import { getKnownInstrumentNames } from './instrumentNames';
import { getActiveLearnedPhrases } from './learnedPhraseService';
import { notifyOperators } from './opsAlert';

// 규칙 검수 카나리아 실행기 (14차 R-1).
//
// **운영 경로와 같은 함수를 부른다** — `collectAutoScreenFindings`. 여기서 지름길을 타면
// 카나리아가 특권 경로를 재게 되어, 검토 답변이 반증 조건으로 지목한 바로 그 상태가 된다
// ("카나리아는 통과했는데 실제 유저는 우회하는 현상").

/** 마지막 성공 시각을 남기는 자리 — 심장박동이 멎은 것 자체가 신호다 */
export const CANARY_HEARTBEAT_KEY = 'screening.canary.lastOk';

/** 다음 점검 예정 시각 — 주기를 아는 곳은 스케줄러 한 곳이고 화면은 이 값을 읽는다 (회신 15호 §3-1) */
export const CANARY_NEXT_AT_KEY = 'screening.canary.nextAt';

/**
 * @근거 설계 — 카나리아 주기 (회신 15호 §1). 외부 호출 0 · DB 쓰기 1행 · 정규식 6회라
 *   큐(직렬, SQLite 단일 기록자·KIS 분당 1회 때문)에 세울 이유가 없다. 스케줄러가 **큐 밖
 *   자기 타이머**로 돌린다 — 앞 작업(판정, 수 분)에 밀리지 않고, 벽시계 분 매칭(":00")을
 *   놓쳐 한 시간이 통째로 비는 일도 없다.
 */
export const CANARY_INTERVAL_MS = 5 * 60_000;

/**
 * @근거 설계 — 박동 문턱 = 주기의 **2배** (2026-08-23 창업자 확정). 재는 순간과 도는 순간이
 *   어긋나기만 해도 걸리면 안 되고, 재기동(배포)은 한 회차를 반드시 비운다 — 10분이면
 *   그 안에 끝난다. **두 번 연속 빠지면 타이머가 죽은 것이지 늦은 것이 아니다.**
 *   3배(15분)에서 내렸다: ARGOS 출근 점검이 "한 번 늦음 / 두 번 죽음"으로 가르게 되면서
 *   같은 잣대를 쓰기로 했다 — 두 검사기가 같은 상자에 나란히 있는데 감시 문턱만 다르면
 *   운영자가 한쪽 표시를 다른 쪽 잣대로 읽는다.
 *   옛 값 24시간은 "프로세스 죽음 2분 / 작업 하나 빠짐 24시간"으로 720배 어긋나 있었고,
 *   뒤쪽이 더 흔한 고장이다 — 프로세스가 살아 있는데 카나리아 작업만 안 도는 상태.
 *   카나리아를 또 감시하면 무한 퇴행이라, 대신 **박동이 멎은 것을 다른 타이머가 본다**:
 *   스케줄러 심박(30초, 큐와 별개)이 이 값을 읽는다. 둘 다 죽으면 스케줄러 자체가 죽은
 *   것이라 기존 워치독이 잡는다 — 거기서 퇴행이 끝난다.
 */
export const CANARY_STALE_MS = 2 * CANARY_INTERVAL_MS;

export interface CanaryReport {
  ran: number;
  failures: CanaryFailure[];
}

/**
 * **재기만 한다** — 알림도 박동도 없다 (2026-08-21).
 *
 * 배치(runScreeningCanary)와 관리자 화면(getCanaryScreen)이 이 한 곳을 공유한다.
 * 화면이 자기 버전을 따로 두면 **화면은 초록인데 배치는 빨간** 상태가 가능해지고,
 * 그때 어느 쪽을 믿을지 아무도 모른다.
 */
export async function runCanaryChecks(prisma: PrismaClient): Promise<CanaryReport> {
  const [knownNames, phrases] = await Promise.all([
    getKnownInstrumentNames(prisma),
    getActiveLearnedPhrases(prisma).catch(() => []),
  ]);

  const failures: CanaryFailure[] = [];
  for (const c of SCREENING_CANARY) {
    // 학생은 빼고 부른다 — 확률적이라 카나리아를 흔들고, 학생에겐 자기 카나리아가 있다
    const { code } = await collectAutoScreenFindings(canaryInput(c), {
      knownNames,
      // 사전 배선 카나리아(Q6): 합성 표식을 함께 주입한다 — 이게 안 잡히면 배선이 끊긴 것
      phrases: [...phrases, CANARY_PHRASE],
    });
    const got = code.map((f) => f.category) as RiskCategory[];
    const fail = checkCanary(c, got);
    if (fail) failures.push(fail);
  }
  return { ran: SCREENING_CANARY.length, failures };
}

/**
 * **변경 직후 1회 탐침** — 박동을 찍지 않는다 (회신 15호 §3·§4).
 *
 * 종목 마스터 동기화·사전 등록/비활성화처럼 규칙의 **입력**이 바뀐 직후에 부른다.
 * 원인 직후 5초와 우연히 5분 뒤는 사고 조사에서 다른 값이다 — 전자는 "이 변경이
 * 깨뜨렸다"가 확정된다. 실패하면 알리되 **박동(lastOk)은 건드리지 않는다**: 박동은
 * "스케줄러의 자기 타이머가 돌고 있다"는 뜻이라, 웹 프로세스(사전 등록)가 찍으면
 * 스케줄러가 한 달 죽어 있어도 자동 점검 ✓ 가 된다 — 그 표시가 잡으려던 고장을
 * 그 표시가 가린다.
 *
 * **어떤 실패도 던지지 않는다** — 이 함수가 등록·동기화를 세우면 안 된다.
 */
export async function runCanaryProbe(prisma: PrismaClient, reason: string): Promise<CanaryReport> {
  const report = await runCanaryChecks(prisma).catch((e) => {
    console.error(`카나리아 탐침 실패 (${reason}):`, e);
    return { ran: 0, failures: [] as CanaryFailure[] };
  });
  if (report.failures.length > 0) await notifyCanaryFailures(prisma, report.failures, reason);
  return report;
}

async function notifyCanaryFailures(
  prisma: PrismaClient,
  failures: CanaryFailure[],
  reason?: string,
): Promise<void> {
  await notifyOperators(prisma, {
    title: `[검수] 규칙 카나리아 ${failures.length}건 실패 — 검수 능력이 지금 떨어져 있습니다`,
    body:
      (reason ? `계기: ${reason}\n` : '') +
      failures
        .map(
          (f) =>
            `· [${f.layer}] ${f.meaning}\n` +
            (f.missing.length > 0 ? `  못 잡음: ${f.missing.join(', ')}\n` : '') +
            (f.unexpected.length > 0 ? `  잘못 잡음: ${f.unexpected.join(', ')}\n` : ''),
        )
        .join('') +
      '\n게시는 계속되지만 위 층이 통과시키는 리포트는 아무도 막지 않습니다.',
    link: '/admin/compliance',
    type: 'COMPLIANCE_REVIEW',
    // 층별로 따로 울린다 — 한 층이 죽은 것과 네 층이 죽은 것은 다른 사고다
    dedupeKey: `screening.canary.${failures.map((f) => f.id).sort().join('+')}`,
  }).catch((e) => console.error('카나리아 알림 실패:', e));
}

/**
 * 카나리아 1회 실행 + 알림·박동 기록 + **다음 예정 시각 발행** (스케줄러의 자기 타이머가 부른다).
 *
 * **어떤 실패도 던지지 않는다** — 이 함수가 게시나 배치를 세우면 안 된다.
 * 하는 일은 관측과 알림뿐이다.
 */
export async function runScreeningCanary(
  prisma: PrismaClient,
  now = new Date(),
): Promise<CanaryReport> {
  // 다음 예정 시각을 먼저 적는다 — 주기를 아는 곳이 여기 한 곳이 되고, 화면은 읽기만 한다.
  // 실행 결과와 무관하게 적는다: "언제 다시 재나"는 통과 여부의 함수가 아니다
  const nextAt = new Date(now.getTime() + CANARY_INTERVAL_MS).toISOString();
  await prisma.appSetting
    .upsert({
      where: { key: CANARY_NEXT_AT_KEY },
      create: { key: CANARY_NEXT_AT_KEY, value: nextAt },
      update: { value: nextAt },
    })
    .catch((e) => console.error('카나리아 예정 시각 기록 실패:', e));

  const { failures } = await runCanaryChecks(prisma);

  if (failures.length > 0) {
    await notifyCanaryFailures(prisma, failures);
  } else {
    // **성공했을 때만 박동을 찍는다.** 실패도 찍으면 "돌긴 돌았다"가 "괜찮다"로 읽힌다
    await prisma.appSetting
      .upsert({
        where: { key: CANARY_HEARTBEAT_KEY },
        create: { key: CANARY_HEARTBEAT_KEY, value: now.toISOString() },
        update: { value: now.toISOString() },
      })
      .catch((e) => console.error('카나리아 박동 기록 실패:', e));
  }

  return { ran: SCREENING_CANARY.length, failures };
}

/**
 * 관리자 화면이 읽는 상태 — **지금 재고, 박동도 함께 본다** (2026-08-21).
 *
 * 두 가지가 서로 다른 고장이라 따로 답한다:
 *   ① **규칙이 지금 살아 있나** — 여기서 직접 돌려 층별로 잰다. 박동만 읽으면
 *      "한 시간 전엔 괜찮았다"까지밖에 못 말하고, 결정적으로 **어느 층이 죽었는지는
 *      저장되지 않는다**(실패는 알림으로만 나간다). 화면의 질문이 "지금 어떤가"라
 *      기록을 읽는 것으로는 답이 안 된다
 *   ② **자동 점검이 돌고 있나** — 규칙은 멀쩡한데 스케줄러가 죽어 있을 수 있다
 *
 * 비용은 정규식 6회 + 조회 2회다(AI 호출 0). 화면이 이미 하는 조회와 겹친다.
 * **던지지 않는다** — 이 함수가 관리자 화면을 죽이면 안 된다.
 */
export interface CanaryScreen {
  ran: number;
  failures: CanaryFailure[];
  /** 자동 점검이 마지막으로 통과한 시각 — 한 번도 없었으면 null */
  lastOkAt: Date | null;
  /** 그 박동이 문턱(주기 2배 = 10분) 넘게 낡았는가 (= 스케줄러의 카나리아 타이머 고장) */
  heartbeatStale: boolean;
  /** 스케줄러가 발행한 다음 점검 예정 시각 — 화면은 주기를 계산하지 않고 이 값을 읽는다 */
  nextAt: Date | null;
}

export async function getCanaryScreen(
  prisma: PrismaClient,
  now = new Date(),
): Promise<CanaryScreen> {
  const [report, row, nextRow] = await Promise.all([
    runCanaryChecks(prisma).catch((e) => {
      console.error('카나리아 화면 실행 실패:', e);
      return { ran: 0, failures: [] as CanaryFailure[] };
    }),
    prisma.appSetting.findUnique({ where: { key: CANARY_HEARTBEAT_KEY } }).catch(() => null),
    prisma.appSetting.findUnique({ where: { key: CANARY_NEXT_AT_KEY } }).catch(() => null),
  ]);
  const last = row ? Date.parse(row.value) : NaN;
  const next = nextRow ? Date.parse(nextRow.value) : NaN;
  return {
    ...report,
    lastOkAt: Number.isFinite(last) ? new Date(last) : null,
    heartbeatStale: !Number.isFinite(last) || now.getTime() - last > CANARY_STALE_MS,
    nextAt: Number.isFinite(next) ? new Date(next) : null,
  };
}

/**
 * **박동만 읽는다 — 카나리아를 돌리지 않는다** (2026-08-23 관리자 앱).
 *
 * 계기판이 30초마다 새로 묻는 값이라 그때마다 6문항을 다시 재면 낭비다. 필요한 것은
 * "언제 통과했나 · 다음은 언제인가"뿐이고 층별 결과는 화면이 자기 렌더에서 이미 잰다.
 *
 * 이 함수가 생긴 이유: `nextAt` 을 서버 렌더 시점의 스냅샷으로만 실었더니, 화면을 5분
 * 넘게 켜 두면 스케줄러가 제때 돌아 값을 새로 써도 화면은 옛 값으로 카운트다운을 끝내고
 * **정상인데 경보 색을 올렸다.**
 */
export async function readCanaryBeat(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ lastOkAt: string | null; nextAt: string | null; heartbeatStale: boolean }> {
  const [row, nextRow] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: CANARY_HEARTBEAT_KEY } }).catch(() => null),
    prisma.appSetting.findUnique({ where: { key: CANARY_NEXT_AT_KEY } }).catch(() => null),
  ]);
  const last = row ? Date.parse(row.value) : NaN;
  const next = nextRow ? Date.parse(nextRow.value) : NaN;
  return {
    lastOkAt: Number.isFinite(last) ? new Date(last).toISOString() : null,
    nextAt: Number.isFinite(next) ? new Date(next).toISOString() : null,
    heartbeatStale: !Number.isFinite(last) || now.getTime() - last > CANARY_STALE_MS,
  };
}

/**
 * **박동이 멎었는가** — 스케줄러 심박 타이머(큐와 별개)가 부른다 (회신 15호: 07:00 일과에서
 * 옮김 — 문턱이 10분인데 알림 주기가 하루면 144배 성기다).
 *
 * 카나리아가 실패하면 카나리아가 알린다. 카나리아가 **아예 안 돌면** 아무도 알리지
 * 않는데, 그것이 이 저장소가 다섯 번 만난 바로 그 모양(조용한 무동작)이다.
 */
export async function alertIfCanaryStale(prisma: PrismaClient, now = new Date()): Promise<boolean> {
  const row = await prisma.appSetting
    .findUnique({ where: { key: CANARY_HEARTBEAT_KEY } })
    .catch(() => null);
  const last = row ? Date.parse(row.value) : NaN;
  const stale = !Number.isFinite(last) || now.getTime() - last > CANARY_STALE_MS;
  if (!stale) return false;

  await notifyOperators(prisma, {
    title: '[검수] 규칙 카나리아가 멈췄습니다 — 검수가 도는지 아무도 모르는 상태입니다',
    body:
      (Number.isFinite(last)
        ? `마지막 정상 확인: ${new Date(last).toISOString()}\n`
        : '정상 확인 기록이 아예 없습니다.\n') +
      '카나리아는 규칙 검수가 실제로 도는지 재는 유일한 장치입니다. ' +
      '이것이 멈춘 동안에는 검수가 조용히 꺼져 있어도 알 방법이 없습니다. ' +
      '스케줄러 프로세스는 살아 있는데 카나리아 타이머만 멈춘 상태일 수 있습니다 — 스케줄러를 재기동하십시오.',
    link: '/admin/compliance',
    type: 'COMPLIANCE_REVIEW',
    dedupeKey: 'screening.canary.stale',
  }).catch((e) => console.error('카나리아 정지 알림 실패:', e));
  return true;
}
