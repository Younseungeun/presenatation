import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudentClient } from '@/infra/compliance/studentClient';
import { createTestDb } from './helpers/testDb';
import {
  STUDENT_ATTENDANCE_INTERVAL_MS,
  STUDENT_ATTENDANCE_LASTOK_KEY,
  STUDENT_ATTENDANCE_RAN_KEY,
  STUDENT_ATTENDANCE_STALE_MS,
  alertIfAttendanceStale,
  markAttendanceTimerScheduled,
  readAttendanceBeat,
  runStudentAttendance,
} from '../studentAttendance';

/**
 * **노트가 두 권이어야 하는 이유** (2026-08-23).
 *
 * `lastOk` 는 **성공했을 때만** 찍힌다. 그래서 그 칸이 비어 있으면 원인이 둘인데
 * 구별이 안 됐다 — ① 타이머가 안 갔다 ② 갔는데 IRIS 가 안 나왔다. 처방은 정반대다:
 * 앞은 스케줄러를 재기동하고 뒤는 사이드카를 봐야 하는데, **알림은 늘 앞쪽이라고
 * 말했다.** 뒤쪽일 때는 엉뚱한 데를 고치라고 시키고 있었던 셈이다.
 *
 * 실제로 2026-08-23 오후 3시~밤 10시가 그 구간이었고, 어느 쪽이었는지는 "그동안
 * 문자가 한 통도 안 왔다"는 사실에서 **사람이 추론**해야 했다. 이 시험이 고정하는
 * 것은 그 추론이 더 이상 필요 없다는 것이다.
 */

let prisma: PrismaClient;
const T0 = new Date('2026-08-23T00:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

/** 늘 답하는 IRIS */
const upClient = (): StudentClient =>
  ({ recheck: vi.fn(async () => true) }) as unknown as StudentClient;
/** 부르면 실패하는 IRIS — 타이머는 정상, 사이드카만 죽은 상태 */
const downClient = (): StudentClient =>
  ({ recheck: vi.fn(async () => false) }) as unknown as StudentClient;

beforeAll(async () => {
  prisma = createTestDb('student-attendance-');
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.appSetting.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({
    data: { email: 'op@example.com', identityVerified: true, role: 'OPERATOR' },
  });
});

describe('노트 1권 — 타이머가 갔다는 기록', () => {
  it('**실패해도 찍힌다** — 이 칸이 답하는 질문은 "성공했나"가 아니라 "갔나"다', async () => {
    await runStudentAttendance(prisma, downClient(), T0);
    const beat = await readAttendanceBeat(prisma, T0);
    expect(beat.lastRanAt?.toISOString()).toBe(T0.toISOString());
    // 실패했으므로 2권은 비어 있다 — 두 칸이 서로 다른 것을 재고 있다는 증거다
    expect(beat.lastOkAt).toBeNull();
  });

  it('성공하면 두 권 다 찍힌다', async () => {
    await runStudentAttendance(prisma, upClient(), T0);
    const beat = await readAttendanceBeat(prisma, T0);
    expect(beat.lastRanAt?.toISOString()).toBe(T0.toISOString());
    expect(beat.lastOkAt?.toISOString()).toBe(T0.toISOString());
    expect(beat.stale).toBe(false);
    expect(beat.timerStale).toBe(false);
  });

  it('학생이 꺼져 있으면 아무것도 안 찍는다 — 갈 사람이 없는 것은 고장이 아니다', async () => {
    await runStudentAttendance(prisma, null, T0);
    const beat = await readAttendanceBeat(prisma, T0);
    expect(beat.lastRanAt).toBeNull();
  });
});

describe('두 고장이 갈린다', () => {
  /**
   * 이 시험이 이 파일의 전부다. 예전에는 아래 두 경우가 **같은 값**이라
   * 같은 문자가 나갔다.
   */
  it('① 타이머가 멎었다 → timerStale, "스케줄러를 재기동하십시오"', async () => {
    // 아무것도 안 돌린 채 문턱을 넘긴다
    const now = later(STUDENT_ATTENDANCE_STALE_MS + 1);
    const beat = await readAttendanceBeat(prisma, now);
    expect(beat.timerStale).toBe(true);
    expect(beat.stale).toBe(true);

    expect(await alertIfAttendanceStale(prisma, upClient(), now)).toBe(true);
    const [note] = await prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 1 });
    expect(note.title).toContain('출근 점검이 멈췄습니다');
    expect(note.body).toContain('스케줄러를 재기동');
  });

  /**
   * ② **타이머는 도는데 IRIS 가 답이 없다 → 여기서는 안 알린다** (2026-08-25 확정).
   *
   * 그 사실을 알리는 문은 이미 있다: `notifyStudentAvailability` 가
   * `[긴급][검수] IRIS 연결 유실` 을 보낸다. 그쪽은 **두 번 연속 실패**해야 나가는
   * 브레이크(B안)를 달고 있고, 근거도 기록이 아니라 **방금 잰 값**이다.
   *
   * 2026-08-24 에 내가 여기에 같은 일을 하는 분기를 얹었는데 브레이크가 없었다.
   * 스케줄러 재기동 직후 첫 점검이 기동 따라잡기에 밀려 한 번 시간 초과했을 때,
   * B안은 옳게 침묵했는데 **이 분기가 먼저 울렸다.**
   */
  it('타이머는 도는데 IRIS 가 계속 실패해도 **여기서는 침묵한다**', async () => {
    // 문턱을 넘기며 계속 점검한다 — 갈 때마다 1권은 새로 찍히고 2권은 끝내 비어 있다
    const client = downClient();
    for (let t = 0; t <= STUDENT_ATTENDANCE_STALE_MS + 1; t += STUDENT_ATTENDANCE_INTERVAL_MS) {
      await runStudentAttendance(prisma, client, later(t));
    }
    const now = later(STUDENT_ATTENDANCE_STALE_MS + 1);
    const beat = await readAttendanceBeat(prisma, now);

    // 노트 둘이 갈린 것은 그대로다 — 화면은 이 값으로 두 고장을 구별한다
    expect(beat.stale).toBe(true);
    expect(beat.timerStale).toBe(false);

    // **울리는 것은 이 함수가 아니다** (notifyStudentAvailability 의 몫)
    expect(await alertIfAttendanceStale(prisma, client, now)).toBe(false);
  });
});

/**
 * **재기동 직후의 헛문자** (2026-08-25 실제 사고 뒤 추가).
 *
 * `lastOk` 는 DB 에 남는다. 스케줄러가 오래 죽어 있다 살아나면 그 값은 **무조건**
 * 낡아 있고, 첫 성공 틱이 돌기 전에 정지 검사가 먼저 지나간다 — 재기동 때마다
 * 반드시 한 번 잘못 울리는 구조였다.
 *
 * 00:23 에 "IRIS 가 응답하지 않습니다 — 사이드카를 보십시오" 가 나갔고 **20초 뒤
 * 근무 중**이었다. 스케줄러가 22시간 죽어 있었고 재기동 직후 첫 점검이 사이드카
 * 기동보다 2분 빨랐다. B안(두 번 연속 실패해야 결근)이 이 경로를 못 막는 이유는
 * 여기서 보는 것이 **잰 값이 아니라 기록**이기 때문이다.
 */
describe('재기동 직후에 울리지 않는다', () => {
  /**
   * `lastOk` 는 DB 에 남는다. 스케줄러가 오래 죽어 있다 살아나면 그 값은 **무조건**
   * 낡아 있다. 그 낡음은 IRIS 에 대한 증거가 아니라 **아무도 안 물어본 시간**의 기록이다.
   */
  it('기록이 낡아도 타이머가 돌고 있으면 침묵한다 — 낡음은 IRIS 의 잘못이 아니다', async () => {
    const now = later(STUDENT_ATTENDANCE_STALE_MS * 10);
    await prisma.appSetting.create({
      data: { key: STUDENT_ATTENDANCE_LASTOK_KEY, value: T0.toISOString() },
    });
    await prisma.appSetting.create({
      data: { key: STUDENT_ATTENDANCE_RAN_KEY, value: now.toISOString() },
    });
    expect((await readAttendanceBeat(prisma, now)).stale).toBe(true);

    // IRIS 가 멀쩡하든(upClient) 아니든(downClient) 이 함수는 울리지 않는다 —
    // IRIS 의 상태를 말하는 것은 notifyStudentAvailability 의 몫이다
    expect(await alertIfAttendanceStale(prisma, upClient(), now)).toBe(false);
    expect(await alertIfAttendanceStale(prisma, downClient(), now)).toBe(false);
  });

  /**
   * **기동 직후 2분 30초의 구멍.** 첫 점검은 카나리아와 어긋나게 하려고 늦게 도는데,
   * 그 사이 `lastRan` 은 직전 실행 때의 값이라 `timerStale` 이 참이 된다 —
   * **방금 켠 스케줄러에게 "재기동하십시오"** 가 나가는 모양이다.
   */
  it('기동 때 예약을 찍어 두면 첫 점검 전에도 타이머가 멎었다고 하지 않는다', async () => {
    const boot = later(STUDENT_ATTENDANCE_STALE_MS * 10);
    // 직전 실행의 낡은 기록만 있는 상태 = 오래 죽어 있다 살아난 직후
    await prisma.appSetting.create({
      data: { key: STUDENT_ATTENDANCE_LASTOK_KEY, value: T0.toISOString() },
    });
    expect((await readAttendanceBeat(prisma, boot)).timerStale).toBe(true);

    await markAttendanceTimerScheduled(prisma, boot);
    expect((await readAttendanceBeat(prisma, boot)).timerStale).toBe(false);
    // 첫 점검이 아직 안 돌았어도 "스케줄러를 재기동하라"고 하지 않는다
    expect(await alertIfAttendanceStale(prisma, upClient(), boot)).toBe(false);
  });
});

describe('정상이면 조용하다', () => {
  it('IRIS 가 답하고 있으면 알리지 않는다', async () => {
    await runStudentAttendance(prisma, upClient(), T0);
    expect(await alertIfAttendanceStale(prisma, upClient(), T0)).toBe(false);
    expect(await prisma.notification.count()).toBe(0);
  });

  it('학생이 꺼져 있으면 알리지 않는다 — 끈 것은 고장이 아니다', async () => {
    const now = later(STUDENT_ATTENDANCE_STALE_MS + 1);
    expect(await alertIfAttendanceStale(prisma, null, now)).toBe(false);
  });

  it('**기록이 없으면 멎은 것으로 본다** — 이 칸은 나중에 생겼고, 낙관하면 진짜 정지를 놓친다', async () => {
    // lastOk 만 있고 lastRan 이 없는 상태 = 이 칸이 생기기 전의 스케줄러가 남긴 기록
    await prisma.appSetting.create({
      data: { key: STUDENT_ATTENDANCE_LASTOK_KEY, value: T0.toISOString() },
    });
    const beat = await readAttendanceBeat(prisma, T0);
    expect(beat.stale).toBe(false); // IRIS 는 방금 답했다
    expect(beat.timerStale).toBe(true); // 그런데 갔다는 기록이 없다
    // 한 회차만 돌면 저절로 풀린다 — 잘못된 경보가 오래 가지 않는다
    await runStudentAttendance(prisma, upClient(), T0);
    expect((await readAttendanceBeat(prisma, T0)).timerStale).toBe(false);
  });
});
