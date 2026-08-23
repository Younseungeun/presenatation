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

  it('② 타이머는 도는데 IRIS 가 계속 실패 → **다른 문자**, "사이드카를 보십시오"', async () => {
    // 문턱을 넘기며 계속 점검한다 — 갈 때마다 1권은 새로 찍히고 2권은 끝내 비어 있다
    const client = downClient();
    for (let t = 0; t <= STUDENT_ATTENDANCE_STALE_MS + 1; t += STUDENT_ATTENDANCE_INTERVAL_MS) {
      await runStudentAttendance(prisma, client, later(t));
    }
    const now = later(STUDENT_ATTENDANCE_STALE_MS + 1);
    const beat = await readAttendanceBeat(prisma, now);

    // **여기가 갈리는 자리다** — 노트가 한 권이었을 때는 둘 다 "박동 없음"이었다
    expect(beat.stale).toBe(true);
    expect(beat.timerStale).toBe(false);

    expect(await alertIfAttendanceStale(prisma, client, now)).toBe(true);
    const [note] = await prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 1 });
    expect(note.title).toContain('IRIS 가 응답하지 않습니다');
    expect(note.body).toContain('사이드카를 보십시오');
    // **재기동하라고 말하지 않는다** — 재기동해도 안 고쳐지는 고장이다
    expect(note.body).not.toContain('스케줄러를 재기동');
  });

  /* **dedupeKey 가 갈렸다는 것은 위 ② 시험이 이미 증명한다.**
     `notifyOperators` 의 dedupe 는 모듈 수준 Map 이라 같은 키는 한동안 다시 안 나가는데,
     ①이 먼저 돌면서 자기 키를 태워 놓았다. 두 고장이 키를 공유했다면 ②의 알림이 그
     자리에서 묻혀 `notification` 이 비었을 것이고, ②는 통과하지 못한다.
     — 그래서 같은 것을 재는 시험을 따로 두지 않는다(둘째 시험은 첫째가 이미 지키는
     성질을 다시 적는 것이라, 깨질 때 둘 다 빨개져 원인만 흐려진다). */
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
