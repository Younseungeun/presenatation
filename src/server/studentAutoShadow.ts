import type { PrismaClient } from '@prisma/client';
import { ROLLBACK_WINDOW, studentRollbackStatus, type RollbackStatus } from '@/domain/studentRollback';
import { readCoverageSnapshot } from '@/domain/coverageMargin';
import { audit } from './auditLog';

// **학생 모델이 스스로를 끈다** (10차 검토 I-6).
//
// 9차에 만든 것은 계기판이었다 — 적자가 나면 운영자 화면에 "shadow로 되돌리는 것을
// 검토하십시오"라고 띄웠다. 그런데 그 문장이 닿는 곳이 정확히 H-1에서 문제로 잡은
// **조용한 채널**이다: 학생이 오탐을 쏟아내도 앱은 멀쩡히 돌기 때문에 운영자가
// 어드민을 열 이유가 없고, 열지 않으면 계기판은 아무 일도 하지 않는다.
//
// 그래서 판단을 사람에게 넘기지 않고 **시스템이 스스로 격하한다.** 격하는 되돌릴 수
// 있는 방향으로만 간다: live → shadow. 학생은 원래 거절 권한이 없으므로 격하의 최악은
// "패러프레이즈를 못 잡는 상태로 돌아가는 것"이고, 그건 학생을 켜기 전의 상태다.
//
// ── 왜 걸쇠(latch)인가 — **관측을 파괴하는 되먹임** ─────────────────
// 이 자리에서 순진한 구현은 **반드시 발진한다.** 순이익을 매번 다시 재서 켜고 끄면:
//
//   적자 → 격하 → 학생이 소견을 안 냄 → 창에서 학생 표본이 빠짐
//        → 표본 부족(`enough=false`) → shouldRollback=false → **다시 켜짐**
//        → 다시 오탐 → 적자 → 격하 → ...
//
// 원인은 지표가 아니라 **개입이 관측 대상을 지운다**는 데 있다. 학생을 끄면 학생의
// 성적을 만들 재료가 끊기므로, 끈 상태에서 잰 값은 "좋아졌다"가 아니라 "모른다"이다.
// 그런데 `studentRollbackStatus`는 그 둘을 같은 얼굴(`shouldRollback=false`)로 돌려준다.
//
// **모르는 것을 좋아진 것으로 읽으면 안 된다.** 그래서 한번 내려간 것은 자동으로
// 올라오지 않는다 — 사람이 재학습하고 채택 판정을 다시 통과시킨 뒤 손으로 푼다.
// 이것은 judgmentPause가 "사람이 건 정지는 사람만 푼다"고 정한 것과 같은 계열이되,
// 근거가 다르다: 저쪽은 *고쳐졌는지 알 방법이 없어서*이고, 이쪽은 *끈 동안에는
// 잴 수 없어서*다.
//
// ── 왜 AppSetting인가 ────────────────────────────────────────────────
// 프로세스 메모리에 두면 재기동이 격하를 지운다 — 사고가 배포로 덮이는 모양이라
// 가장 나쁘다. 스키마를 늘리지 않고 이미 있는 KV를 쓴다(judgmentPause와 같은 관례).

/** 걸쇠의 자리. `1`이면 격하되어 있다 */
const LATCH_KEY = 'student.auto_shadow';

/**
 * 시스템이 스스로 내린 격하의 표식 (AppSetting.updatedBy).
 * 사람이 내린 것과 갈라 두면 "누가 껐나"가 기록에 남고, 나중에 자동 복구를 붙이더라도
 * 사람의 판단을 덮어쓰지 않는다 — judgmentPause의 SYSTEM_PAUSE_ACTOR와 같은 규율이다.
 */
export const AUTO_SHADOW_ACTOR = 'system:student-rollback';

/**
 * 걸쇠를 다시 읽기까지의 시간.
 *
 * @근거 설계 — 리포트 한 건마다 DB를 한 번 더 치는 것을 피하되, 격하가 걸린 뒤
 *   반영이 늦어지는 시간을 사람이 못 느낄 정도로 둔다. 30초면 게시가 몰리는 순간에도
 *   추가 질의가 분당 두 번이고, 격하 지연은 리포트 한두 건이다(학생은 WARN만 내므로
 *   그 한두 건의 최악은 "운영자 큐에 잘못 들어간 것"이지 거절이 아니다).
 */
const LATCH_CACHE_MS = 30_000;

/**
 * 순이익을 다시 재는 주기.
 *
 * @근거 설계 — 이쪽은 검수 기록 200건을 읽는 질의라 걸쇠 읽기보다 훨씬 무겁다.
 *   창이 50건인데 5분 사이에 50건이 새로 들어올 유입량이 아니므로(출시 직후 목표가
 *   리서처 30~50명), 5분이면 창 하나가 통째로 바뀌기 전에 반드시 한 번은 잰다.
 */
const EVAL_INTERVAL_MS = 5 * 60_000;

let latchCache: { on: boolean; until: number } | null = null;
let lastEvalAt = 0;

/** 시험이 프로세스 캐시를 넘어 서로를 오염시키지 않게 */
export function resetAutoShadowCache(): void {
  latchCache = null;
  lastEvalAt = 0;
}

/**
 * **지금 자동 격하가 걸려 있는가** — 라이브 진입 직전에 묻는다.
 *
 * 조회 실패는 `false`(격하 아님)로 답한다. 걸쇠를 못 읽는다고 학생을 끄면 DB가
 * 잠깐 흔들릴 때마다 검수가 약해지는데, 그건 이 함수가 막으려는 것보다 흔한 사고다.
 * 못 읽었다는 사실은 로그에 남고, 다음 호출에서 다시 시도한다.
 */
export async function isAutoShadowed(prisma: PrismaClient, now = Date.now()): Promise<boolean> {
  if (latchCache && now < latchCache.until) return latchCache.on;
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: LATCH_KEY },
      select: { value: true },
    });
    const on = row?.value === '1';
    latchCache = { on, until: now + LATCH_CACHE_MS };
    return on;
  } catch (e) {
    console.error('학생 자동 격하 상태 조회 실패:', e);
    return false;
  }
}

/**
 * **걸쇠를 건다.** 이미 걸려 있으면 아무 일도 하지 않는다(`false`).
 *
 * 되돌릴 수 있는 방향으로만 움직인다 — 거는 것은 시스템, 푸는 것은 사람이다.
 */
export async function engageAutoShadow(
  prisma: PrismaClient,
  reason: string,
  now = new Date(),
): Promise<boolean> {
  try {
    const existing = await prisma.appSetting.findUnique({
      where: { key: LATCH_KEY },
      select: { value: true },
    });
    if (existing?.value === '1') return false;
    await prisma.appSetting.upsert({
      where: { key: LATCH_KEY },
      update: { value: '1', updatedBy: AUTO_SHADOW_ACTOR, updatedAt: now },
      create: { key: LATCH_KEY, value: '1', updatedBy: AUTO_SHADOW_ACTOR, updatedAt: now },
    });
    latchCache = { on: true, until: now.getTime() + LATCH_CACHE_MS };
    console.error(`학생 모델 자동 격하 — ${reason}`);
    return true;
  } catch (e) {
    console.error('학생 자동 격하 기록 실패:', e);
    return false;
  }
}

/**
 * **해제해도 되는 상태인가** — 코드가 1차로 확인한다 (11차 K-4).
 *
 * 10차의 유일한 문턱은 확인 창 하나였다("재채택을 통과시켰습니까?"). 그런데 그 질문에
 * 답하는 사람과 답을 검증할 수 있는 사람이 같으면 그것은 문턱이 아니라 인사말이다.
 *
 * 검사하는 것은 **증거의 신선도** 하나다: 커버리지 스냅숏이 지금 서빙 중인 가중치로
 * 떠졌는가. 스냅숏은 `eval:student`가 채택선을 통과했을 때만 갱신되므로(합산이
 * 후퇴하면 기록을 거부한다), 그 두 sha가 같다는 것은 **지금 이 모델이 채택 판정을
 * 통과했다**는 뜻이 된다.
 *
 * **막는 것이 끝이 아니다.** 사고 복구 중에는 운영자가 코드보다 현장을 잘 안다 —
 * 그때 코드가 완전 통제하면 장애 응대가 마비된다. 그래서 `forceReleaseAutoShadow`가
 * 사유와 함께 우회를 허용하고, 그 우회만 감사 로그에 남는다.
 */
export async function canReleaseAutoShadow(
  servedModelSha: string | null | undefined,
): Promise<{ ok: boolean; reason: string }> {
  const snapshot = readCoverageSnapshot();
  if (!snapshot) {
    return {
      ok: false,
      reason:
        '커버리지 스냅숏이 없습니다 — `npm run eval:student -- --write-snapshot` 으로 채택 판정을 다시 통과시키십시오.',
    };
  }
  if (!servedModelSha) {
    return { ok: false, reason: '사이드카가 어떤 가중치를 서빙 중인지 확인할 수 없습니다.' };
  }
  if (snapshot.modelSha !== servedModelSha) {
    return {
      ok: false,
      reason:
        `채택 판정을 통과한 가중치(${snapshot.modelSha}, ${snapshot.measuredAt})와 ` +
        `지금 서빙 중인 것(${servedModelSha})이 다릅니다 — 지금 모델은 채택선을 통과한 적이 없습니다.`,
    };
  }
  return { ok: true, reason: `채택 판정 통과 확인 (${snapshot.modelSha}, ${snapshot.measuredAt})` };
}

/**
 * **증거 없이 강제로 푼다** (11차 K-4) — 사고 복구용.
 *
 * 사유를 요구하고 감사 로그에 남긴다. 사유가 형식적이어도 상관없다 —
 * 이 줄의 값어치는 문장의 내용이 아니라 **그런 결정이 있었다는 사실과 시각**이다.
 */
export async function forceReleaseAutoShadow(
  prisma: PrismaClient,
  operatorId: string,
  reason: string,
  now = new Date(),
): Promise<void> {
  if (!reason.trim()) throw new Error('강제 해제에는 사유가 필요합니다');
  await releaseAutoShadow(prisma, operatorId, now);
  await audit(prisma, {
    actor: operatorId,
    actorType: 'OPERATOR',
    action: 'STUDENT_SHADOW_FORCE_RELEASED',
    targetType: 'AppSetting',
    targetId: LATCH_KEY,
    reason: reason.trim(),
    at: now,
  });
}

/**
 * **사람이 푼다.** 운영자가 재학습·재채택을 마친 뒤에만 부른다.
 * 값을 지우지 않고 `0`으로 눕히는 이유: `updatedBy`가 남아야 "누가 언제 풀었나"를 센다.
 *
 * ⚠ 관문을 통과했는지는 **호출자가 확인한다**(`canReleaseAutoShadow`). 이 함수 안에
 * 넣으면 강제 해제 경로가 자기가 막는 검사를 우회하려고 같은 함수를 두 벌 쓰게 된다.
 */
export async function releaseAutoShadow(
  prisma: PrismaClient,
  operatorId: string,
  now = new Date(),
): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: LATCH_KEY },
    update: { value: '0', updatedBy: operatorId, updatedAt: now },
    create: { key: LATCH_KEY, value: '0', updatedBy: operatorId, updatedAt: now },
  });
  latchCache = { on: false, until: now.getTime() + LATCH_CACHE_MS };
}

export interface AutoShadowEvaluation {
  /** 이번 호출에서 실제로 쟀는가 (주기가 안 됐으면 false) */
  evaluated: boolean;
  /** 이번 호출이 걸쇠를 새로 걸었는가 */
  engaged: boolean;
  status: RollbackStatus | null;
}

/**
 * **순이익을 다시 재고, 적자면 격하한다.**
 *
 * 게시 트랜잭션 **밖에서** 부른다 — 채점 질의가 실패해도 게시는 이미 끝나 있어야 한다.
 * 어떤 실패도 던지지 않는다: 자동 격하 장치가 게시를 죽이면 "권한 없는 판정이 게시를
 * 막는" 바로 그 실패가 되고, 그건 학생에게 거절 권한을 주지 않기로 한 이유와 같다.
 *
 * @param labeled 운영자 판정이 붙은 검수 기록 (최신순). 조회는 호출자가 한다 —
 *   이 함수를 순수하게 두면 합성 데이터로 격발 지점을 검증할 수 있다 (I-6).
 */
export async function evaluateAutoShadow(
  prisma: PrismaClient,
  labeled: Parameters<typeof studentRollbackStatus>[0],
  now = new Date(),
): Promise<AutoShadowEvaluation> {
  const t = now.getTime();
  if (t - lastEvalAt < EVAL_INTERVAL_MS) return { evaluated: false, engaged: false, status: null };
  lastEvalAt = t;
  const status = studentRollbackStatus(labeled, ROLLBACK_WINDOW);
  if (!status.shouldRollback) return { evaluated: true, engaged: false, status };
  const engaged = await engageAutoShadow(prisma, status.summary, now);
  return { evaluated: true, engaged, status };
}
