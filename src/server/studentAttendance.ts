import type { PrismaClient } from '@prisma/client';
import type { StudentClient } from '@/infra/compliance/studentClient';
import { notifyStudentAvailability } from './complianceService';
import { notifyOperators } from './opsAlert';
import { CANARY_INTERVAL_MS, CANARY_STALE_MS } from './screeningCanaryRunner';

// IRIS 출근 점검 — 규칙 카나리아와 대칭 (회신 16호).
//
// 검수하는 것이 둘인데 스스로 확인하는 것은 하나뿐이었다. 규칙에는 카나리아가 있어 아무 일이
// 없어도 5분마다 재는데, IRIS 는 게시할 때(집행)와 운영자가 계기판을 열 때만 확인됐다 —
// 리포트를 아무도 올리지 않으면 IRIS 가 죽어도 알림이 나가지 않았다. 2026-08-22 토크나이저
// 지문이 갈렸을 때 얼마나 오래 빠져 있었는지 지금도 모르는 이유가 이것이다(잰 기록이 없다).
//
// **집행은 그대로다** — 게시 때의 실시간 usable() 은 이 점검이 대신하지 않는다. 5분 된 사실로
// 남의 게시를 통과시킬 수 없다. 이것은 아무도 안 볼 때를 위한 눈이다.

/** 마지막으로 출근이 확인된 시각 — 성공했을 때만 찍는다 (카나리아와 같은 규칙) */
export const STUDENT_ATTENDANCE_LASTOK_KEY = 'student.attendance.lastOk';
/**
 * 마지막으로 **점검을 시도한** 시각 — 결과와 무관하게 찍는다 (2026-08-23).
 *
 * `lastOk` 하나로는 두 고장이 같은 모양이었다: **타이머가 안 돌았다**와 **타이머는
 * 돌았는데 IRIS 가 계속 실패했다**. 둘 다 "박동 없음"으로 보이는데 처방은 정반대다 —
 * 앞은 스케줄러를 재기동하고 뒤는 사이드카를 봐야 한다. 알림이 늘 앞쪽이라고 말하고
 * 있었으므로, 뒤쪽일 때는 **엉뚱한 데를 고치라고 시키고 있었다.**
 *
 * 실제로 2026-08-23 오후 3시~밤 10시에 이 구분이 필요했다. 결과를 보고 사람이
 * 추론해야 했던 것을 이 칸 하나가 그 자리에서 답한다.
 */
export const STUDENT_ATTENDANCE_RAN_KEY = 'student.attendance.lastRan';
/** 다음 점검 예정 시각 — 주기를 아는 곳은 스케줄러 한 곳, 화면은 읽기만 */
export const STUDENT_ATTENDANCE_NEXT_AT_KEY = 'student.attendance.nextAt';

/** 주기·문턱은 카나리아 것을 그대로 쓴다 — 두 곳에 적으면 언젠가 갈린다 (회신 15호 ③-1) */
export const STUDENT_ATTENDANCE_INTERVAL_MS = CANARY_INTERVAL_MS;
export const STUDENT_ATTENDANCE_STALE_MS = CANARY_STALE_MS;

/**
 * @근거 설계 — 카나리아와 주기의 절반만큼 어긋나게 시작한다 (회신 16호 §1-1). 같은 순간에
 *   박동 둘을 적으면 SQLite 쓰기가 잠깐 막히고, IRIS 점검(사이드카 9회 호출, ~0.4~1초)과
 *   카나리아(~165ms)가 겹치면 한 틱이 길어져 30초 심박이 밀린다. 손으로 2분 30초를 적지
 *   않는다 — 주기가 바뀌면 따라가야 한다. 벽시계 나머지가 아니라 **기동 때 그만큼 늦게
 *   시작**하는 쪽이라 재기동해도 간격이 유지된다.
 */
export const STUDENT_ATTENDANCE_OFFSET_MS = CANARY_INTERVAL_MS / 2;

export interface AttendanceResult {
  ok: boolean;
  /** 전이(붙음↔끊김)가 있어 알림이 나갔는가 */
  notified: 'sent' | 'unchanged' | 'failed';
}

/**
 * 출근 점검 1회 — **recheck() 로 잰다.** usable() 은 성공을 프로세스 수명 내내 캐시하므로
 * 5분마다 불러도 첫 회만 진짜 점검이다(회신 16호 §2). recheck 가 없는 구현(캐시 없는 목)은
 * usable 과 같은 일이라 그대로 쓴다.
 *
 * 알림은 **전이일 때만** (§3) — 사이드카 재기동 중에도 실패라 5분마다 울리면 경보 피로다.
 * consumeAvailabilityChange() 가 전이만 1회용으로 돌려주고, notifyStudentAvailability 가
 * 집행 경로와 같은 문구로 보낸다 — 문구가 두 벌이 되지 않는다.
 *
 * **어떤 실패도 던지지 않는다.**
 */
export async function runStudentAttendance(
  prisma: PrismaClient,
  client: StudentClient | null,
  now = new Date(),
): Promise<AttendanceResult | null> {
  if (!client) return null; // 학생이 꺼져 있으면(STUDENT_SIDECAR_URL 없음) 출근할 사람이 없다

  const nextAt = new Date(now.getTime() + STUDENT_ATTENDANCE_INTERVAL_MS).toISOString();
  await prisma.appSetting
    .upsert({
      where: { key: STUDENT_ATTENDANCE_NEXT_AT_KEY },
      create: { key: STUDENT_ATTENDANCE_NEXT_AT_KEY, value: nextAt },
      update: { value: nextAt },
    })
    .catch((e) => console.error('IRIS 출근 점검 예정 시각 기록 실패:', e));

  // **돌았다는 사실부터 찍는다** — 재기 전에 찍는 이유는 이 칸이 답하는 질문이
  // "성공했나"가 아니라 "타이머가 이 시각에 살아 있었나"이기 때문이다. 점검 자체가
  // 던지거나 프로세스가 그 도중에 죽어도 **여기까지 왔다는 사실**은 남아야 한다
  await prisma.appSetting
    .upsert({
      where: { key: STUDENT_ATTENDANCE_RAN_KEY },
      create: { key: STUDENT_ATTENDANCE_RAN_KEY, value: now.toISOString() },
      update: { value: now.toISOString() },
    })
    .catch((e) => console.error('IRIS 출근 점검 시도 기록 실패:', e));

  const ok = await (client.recheck ? client.recheck() : client.usable()).catch(() => false);

  if (ok) {
    // **성공했을 때만 박동을 찍는다** — 실패도 찍으면 "돌긴 돌았다"가 "괜찮다"로 읽힌다
    await prisma.appSetting
      .upsert({
        where: { key: STUDENT_ATTENDANCE_LASTOK_KEY },
        create: { key: STUDENT_ATTENDANCE_LASTOK_KEY, value: now.toISOString() },
        update: { value: now.toISOString() },
      })
      .catch((e) => console.error('IRIS 출근 박동 기록 실패:', e));
  }
  const notified = await notifyStudentAvailability(prisma, client).catch(() => 'failed' as const);
  return { ok, notified };
}

/**
 * **타이머가 예약됐다는 사실을 기동 때 찍는다** (2026-08-25).
 *
 * 첫 점검은 카나리아와 어긋나게 하려고 주기의 절반(2분 30초)만큼 늦게 돈다
 * (STUDENT_ATTENDANCE_OFFSET_MS). 그 사이에는 `lastRan` 이 **직전 실행 때의 값**이라,
 * 스케줄러가 오래 죽어 있었다면 재기동 직후 2분 30초 동안 `timerStale` 이 참이 된다 —
 * **방금 켠 스케줄러를 두고 "스케줄러를 재기동하십시오" 라고 말하게 된다.**
 *
 * 이 칸이 답하는 질문은 "타이머가 살아 있나"이고, 기동한 순간 그 답은 참이다.
 * 점검이 실제로 돈 시각은 `runStudentAttendance` 가 곧바로 덮어쓴다.
 */
export async function markAttendanceTimerScheduled(
  prisma: PrismaClient,
  now = new Date(),
): Promise<void> {
  await prisma.appSetting
    .upsert({
      where: { key: STUDENT_ATTENDANCE_RAN_KEY },
      create: { key: STUDENT_ATTENDANCE_RAN_KEY, value: now.toISOString() },
      update: { value: now.toISOString() },
    })
    .catch((e) => console.error('IRIS 출근 타이머 예약 기록 실패:', e));
}

export interface AttendanceBeat {
  /** 노트 2권 — IRIS 가 마지막으로 **답한** 시각 */
  lastOkAt: Date | null;
  /** 노트 1권 — 타이머가 마지막으로 **물어보러 간** 시각 (결과 무관) */
  lastRanAt: Date | null;
  nextAt: Date | null;
  /** IRIS 의 답이 문턱(주기 2배 = 10분) 넘게 없다 — **어느 쪽 고장인지는 말하지 않는다** */
  stale: boolean;
  /**
   * **타이머 자신이** 문턱 넘게 안 돌았다 = 스케줄러의 점검 타이머가 멎었다.
   *
   * `stale && !timerStale` 이면 정반대의 뜻이다 — 타이머는 멀쩡히 도는데 IRIS 가
   * 계속 응답하지 않는 것이라, 재기동할 대상이 스케줄러가 아니라 사이드카다.
   */
  timerStale: boolean;
}

/** 화면이 읽는 값 — 재지 않는다. "지금 어떤가"는 화면이 recheck 로 따로 잰다(회신 16호 §6) */
export async function readAttendanceBeat(prisma: PrismaClient, now = new Date()): Promise<AttendanceBeat> {
  const [okRow, ranRow, nextRow] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: STUDENT_ATTENDANCE_LASTOK_KEY } }).catch(() => null),
    prisma.appSetting.findUnique({ where: { key: STUDENT_ATTENDANCE_RAN_KEY } }).catch(() => null),
    prisma.appSetting.findUnique({ where: { key: STUDENT_ATTENDANCE_NEXT_AT_KEY } }).catch(() => null),
  ]);
  const last = okRow ? Date.parse(okRow.value) : NaN;
  const ran = ranRow ? Date.parse(ranRow.value) : NaN;
  const next = nextRow ? Date.parse(nextRow.value) : NaN;
  return {
    lastOkAt: Number.isFinite(last) ? new Date(last) : null,
    lastRanAt: Number.isFinite(ran) ? new Date(ran) : null,
    nextAt: Number.isFinite(next) ? new Date(next) : null,
    stale: !Number.isFinite(last) || now.getTime() - last > STUDENT_ATTENDANCE_STALE_MS,
    // **없으면 멎은 것으로 본다** — 이 칸은 2026-08-23에 생겨서, 그 전에 돌던
    // 스케줄러의 기록에는 없다. 다만 한 회차(5분)만 돌면 채워지므로 잘못된 경보가
    // 오래 가지 않고, 반대로 낙관하면 진짜 정지를 놓친다
    timerStale: !Number.isFinite(ran) || now.getTime() - ran > STUDENT_ATTENDANCE_STALE_MS,
  };
}

/**
 * **출근 점검이 멎었는가** — 스케줄러 심박 타이머가 부른다 (카나리아 박동과 같은 자리).
 * 점검이 "결근"이라고 말하는 것과 점검이 **아예 안 도는 것**은 다른 고장이다. 전자는
 * notifyStudentAvailability 가, 후자는 이것이 알린다. dedupeKey 로 한 번만.
 */
export async function alertIfAttendanceStale(
  prisma: PrismaClient,
  client: StudentClient | null,
  now = new Date(),
): Promise<boolean> {
  if (!client) return false; // 학생이 꺼져 있으면 점검도 없는 것이 정상이다
  const beat = await readAttendanceBeat(prisma, now);

  const min = Math.round(STUDENT_ATTENDANCE_STALE_MS / 60_000);
  const interval = Math.round(STUDENT_ATTENDANCE_INTERVAL_MS / 60_000);
  const lastOkLine = beat.lastOkAt
    ? `마지막 출근 확인: ${beat.lastOkAt.toISOString()}\n`
    : '출근 확인 기록이 아예 없습니다.\n';

  /* **타이머가 멎은 것은 IRIS 와 무관하다** — 먼저, 따로 본다 (2026-08-25 구조 수정).
     예전에는 함수 전체가 `stale`(= lastOk 기준)로 잠겨 있었는데, 두 알림 중 하나는
     `lastRan` 에 대한 것이라 **잠금과 주장이 서로 다른 값을 보고 있었다.**
     여기서 요점은 "IRIS 가 살아 있나"가 아니라 **"아무도 확인하지 않고 있다"** 이므로
     아래의 되물음(IRIS 에게 직접 묻기)을 태우지 않는다 — IRIS 가 멀쩡해도 재는
     사람이 없으면 그 사실은 그대로 사고다. */
  if (beat.timerStale) {
    await notifyOperators(prisma, {
      title: '[검수] IRIS 출근 점검이 멈췄습니다 — IRIS 가 도는지 아무도 모르는 상태입니다',
      body:
        lastOkLine +
        `${interval}분 주기 점검이 ${min}분 넘게 **돌지 않았습니다.** IRIS 가 죽은 것이 ` +
        '아니라 물어보러 가는 타이머가 멎은 것이라, IRIS 자체는 멀쩡할 수도 있습니다 — ' +
        '어느 쪽이든 지금은 아무도 확인하지 않고 있습니다. 스케줄러를 재기동하십시오.',
      dedupeKey: 'student.attendance.stale',
      link: '/admin/compliance',
      type: 'COMPLIANCE_REVIEW',
    }).catch((e) => console.error('IRIS 출근 정지 알림 실패:', e));
    return true;
  }

  if (!beat.stale) return false;

  /* **울리기 전에 한 번 직접 물어본다** (2026-08-25 창업자 지시 — 실제 헛문자 뒤).
     ── 왜 필요한가 ──────────────────────────────────────────────────
     `lastOk` 는 DB 에 남는다. 스케줄러가 오래 죽어 있다가 살아나면 그 값은 **무조건**
     낡아 있고, 첫 성공 틱이 돌기 전에 이 검사가 먼저 지나간다 — 즉 **재기동 때마다
     반드시 한 번 잘못 울린다.** 실제로 그랬다: 2026-08-25 00:23 에
     "IRIS 가 응답하지 않습니다 — 사이드카를 보십시오" 가 나갔고 **20초 뒤 근무 중**이었다.
     (스케줄러가 22시간 죽어 있었고, 재기동 직후 첫 점검이 사이드카 기동보다 2분 빨랐다.)
     B안(두 번 연속 실패해야 결근)은 IRIS 가 삐끗하는 것을 막지만 이 경로는 못 막는다 —
     여기서 보는 것은 잰 값이 아니라 **기록**이기 때문이다.
     ── 왜 안전한가 ──────────────────────────────────────────────────
     이 물음은 `stale` 일 때만 나간다. 정상 운영에서는 그 경우가 없으므로 사이드카
     호출이 늘지 않는다. 실패하면(못 물어봄) 종전대로 알린다 — 침묵하는 쪽으로
     기울면 진짜 장애를 놓친다. */
  const answersNow = await (client.recheck ? client.recheck() : client.usable()).catch(() => false);
  if (answersNow) {
    // 낡은 기록은 지나간 일이다. **그 사실을 지금 찍어 둔다** — 안 찍으면 다음 회차가
    // 같은 낡은 값을 보고 또 여기까지 온다(30초마다 사이드카를 부르게 된다)
    await prisma.appSetting
      .upsert({
        where: { key: STUDENT_ATTENDANCE_LASTOK_KEY },
        create: { key: STUDENT_ATTENDANCE_LASTOK_KEY, value: now.toISOString() },
        update: { value: now.toISOString() },
      })
      .catch((e) => console.error('IRIS 출근 박동 기록 실패:', e));
    return false;
  }

  await notifyOperators(prisma, {
    title: '[검수] IRIS 가 응답하지 않습니다 — 점검은 돌고 있는데 답이 없습니다',
    body:
      lastOkLine +
      `점검 타이머는 ${interval}분마다 정상으로 돌고 있습니다(마지막 시도: ` +
      `${beat.lastRanAt?.toISOString() ?? '기록 없음'}). 그런데 IRIS 가 ${min}분 넘게 ` +
      '한 번도 답하지 않았고, **방금 다시 물어봤는데도 답하지 않았습니다** — ' +
      '스케줄러가 아니라 사이드카를 보십시오. 그동안 게시는 전부 보류로 갑니다.',
    dedupeKey: 'student.attendance.unreachable',
    link: '/admin/compliance',
    type: 'COMPLIANCE_REVIEW',
  }).catch((e) => console.error('IRIS 출근 정지 알림 실패:', e));
  return true;
}
