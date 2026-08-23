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

export interface AttendanceBeat {
  lastOkAt: Date | null;
  nextAt: Date | null;
  /** 박동이 문턱(주기 2배 = 10분) 넘게 낡았는가 = 스케줄러의 출근 점검 타이머가 멎었다 */
  stale: boolean;
}

/** 화면이 읽는 값 — 재지 않는다. "지금 어떤가"는 화면이 recheck 로 따로 잰다(회신 16호 §6) */
export async function readAttendanceBeat(prisma: PrismaClient, now = new Date()): Promise<AttendanceBeat> {
  const [okRow, nextRow] = await Promise.all([
    prisma.appSetting.findUnique({ where: { key: STUDENT_ATTENDANCE_LASTOK_KEY } }).catch(() => null),
    prisma.appSetting.findUnique({ where: { key: STUDENT_ATTENDANCE_NEXT_AT_KEY } }).catch(() => null),
  ]);
  const last = okRow ? Date.parse(okRow.value) : NaN;
  const next = nextRow ? Date.parse(nextRow.value) : NaN;
  return {
    lastOkAt: Number.isFinite(last) ? new Date(last) : null,
    nextAt: Number.isFinite(next) ? new Date(next) : null,
    stale: !Number.isFinite(last) || now.getTime() - last > STUDENT_ATTENDANCE_STALE_MS,
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
  if (!beat.stale) return false;
  await notifyOperators(prisma, {
    title: '[검수] IRIS 출근 점검이 멈췄습니다 — IRIS 가 도는지 아무도 모르는 상태입니다',
    body:
      (beat.lastOkAt
        ? `마지막 출근 확인: ${beat.lastOkAt.toISOString()}\n`
        : '출근 확인 기록이 아예 없습니다.\n') +
      '5분 주기 점검의 박동이 10분 넘게 없습니다. IRIS 자체의 장애는 따로 알립니다 — 이것은 ' +
      '스케줄러의 점검 타이머가 멎었다는 뜻입니다. 스케줄러를 재기동하십시오.',
    link: '/admin/compliance',
    type: 'COMPLIANCE_REVIEW',
    dedupeKey: 'student.attendance.stale',
  }).catch((e) => console.error('IRIS 출근 정지 알림 실패:', e));
  return true;
}
