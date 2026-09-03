import type { PrismaClient } from '@prisma/client';
import { notifyOperators } from './opsAlert';

// **학생 장애 밸브 — 시한폭탄이다** (21차 Y-1(b) 검토 확정 · 관리자 앱 2회차 B-3).
//
// ── 왜 환경 변수가 아닌가 ────────────────────────────────────────────
// Q0-b 초안은 "운영자가 STUDENT_MODE=shadow 로 내린다"였는데, .env 는 서버 재시작이
// 필요하다. 이 밸브가 필요한 순간은 정확히 새벽 3시에 사이드카가 죽어 큐가 쌓이는
// 때라 SSH 재시작은 현실적이지 않다(관리자 앱 B-3 지적). 판정 정지 스위치·띠지가
// 이미 쓰는 AppSetting 런타임 토글로 바꿨다. **내리는 것도 켜는 것도 운영자다** —
// 정산 동결과 달리 양쪽 다 운영 판단이라 비대칭을 둘 이유가 없다.
//
// ── 왜 시한폭탄인가 (21차 검토의 핵심 처방) ──────────────────────────
// 밸브가 내려진 상태는 검수가 약해진 채 게시가 흐르는 상태다. 되돌릴 조건 없이
// 두면 내린 채 잊히고, 그러면 Q0 정책이 없던 시절과 같아진다 — **"조용히 약해지는
// 상태는 자기 고장을 보고할 수 없다"**(21차 반증 이력의 교훈). 그래서:
//   ① 내리면 2시간 뒤 저절로 되살아난다 (연장은 다시 내리는 것 — 매번 사람의 판단)
//   ② 사이드카가 복구되면 즉시 무의미해진다 (usable 통과 → outage 아님 → 밸브 무관)
//   ③ 밸브로 흘러간 건은 전부 ComplianceReview.studentAbsence='VALVE_BYPASS' 로
//      영구히 남는다 — "학생 소견 0(정상)"과 "학생 결석(우회)"을 지표에서 가른다

const OUTAGE_SINCE_KEY = 'screening.student.outage.since';
const BYPASS_UNTIL_KEY = 'screening.student.bypass.until';

/** @근거 설계 — 21차 Y-1(b) 검토 확정값: 밸브는 2시간 뒤 자동 복귀한다 */
export const STUDENT_BYPASS_TTL_MS = 2 * 60 * 60 * 1000;

export interface StudentBypassState {
  active: boolean;
  until: Date | null;
}

/** 밸브를 내린다 — 장애 보류를 2시간 동안 우회. 연장은 다시 눌러야 한다 */
export async function engageStudentBypass(
  prisma: PrismaClient,
  operatorUserId: string,
  now = new Date(),
): Promise<StudentBypassState> {
  const until = new Date(now.getTime() + STUDENT_BYPASS_TTL_MS);
  await prisma.appSetting.upsert({
    where: { key: BYPASS_UNTIL_KEY },
    create: { key: BYPASS_UNTIL_KEY, value: until.toISOString(), updatedBy: operatorUserId },
    update: { value: until.toISOString(), updatedBy: operatorUserId },
  });
  // 우회는 조용히 일어나면 안 되는 사건이다 — 자동 격하 알림과 같은 계열
  await notifyOperators(prisma, {
    title: '[검수] 장애 우회 밸브 내림 — ARGOS 없이 게시가 흐릅니다',
    body:
      `지금부터 2시간 동안 학생 장애 보류가 우회됩니다 (${until.toISOString()} 까지). ` +
      '우회로 흘러간 건은 전부 VALVE_BYPASS 로 표시되며, 시간이 지나면 자동으로 보류가 되살아납니다.',
    link: '/admin/compliance',
    type: 'COMPLIANCE_REVIEW',
    dedupeKey: 'student.bypass.engaged',
  });
  return { active: true, until };
}

/** 밸브를 미리 올린다 (만료를 기다리지 않고) */
export async function releaseStudentBypass(
  prisma: PrismaClient,
  _operatorUserId: string,
): Promise<void> {
  await prisma.appSetting.deleteMany({ where: { key: BYPASS_UNTIL_KEY } });
}

/**
 * 밸브 상태 — 만료는 지연 평가다 (승인서 72시간과 같은 방식: 배치가 아니라
 * 읽는 순간 비교한다). 낡은 키가 남아 있어도 active=false 로 읽히므로 무해하다.
 */
export async function getStudentBypass(
  prisma: PrismaClient,
  now = new Date(),
): Promise<StudentBypassState> {
  const row = await prisma.appSetting.findUnique({ where: { key: BYPASS_UNTIL_KEY } });
  if (!row) return { active: false, until: null };
  const until = new Date(row.value);
  if (!Number.isFinite(until.getTime()) || until.getTime() <= now.getTime()) {
    return { active: false, until: null };
  }
  return { active: true, until };
}

/**
 * 장애 전이 기록 (관리자 앱 2회차 B-1) — 띠지의 "장애 N시간째"의 원천.
 *
 * (나)안이다: 전이 시각을 별도 키에 쓰고 복구 시 지운다. (가)안(마지막 정상 시각)을
 * 버린 이유 — lastOk 는 매 성공마다 써야 정확한데 그건 검수 경로의 상시 쓰기이고,
 * 아껴 쓰면 "마지막 검수 시각"이지 "장애 시작 시각"이 아니게 된다(검수가 뜸한 밤에는
 * N시간째가 부풀려진다). 전이 기록은 장애 중에만 쓰고, 프로세스 재시작에도 안전하다 —
 * 키의 존재 자체가 이전 상태라 전이 판별에 메모리가 필요 없다.
 *
 * 의도된 끔(off·shadow·걸쇠)은 장애가 아니다 — 호출자가 라이브 경로의 결과만 넘긴다.
 */
export async function recordStudentOutage(
  prisma: PrismaClient,
  outage: boolean,
  now = new Date(),
): Promise<void> {
  const existing = await prisma.appSetting.findUnique({ where: { key: OUTAGE_SINCE_KEY } });
  if (outage) {
    if (!existing) {
      await prisma.appSetting.create({
        data: { key: OUTAGE_SINCE_KEY, value: now.toISOString() },
      });
    }
    return;
  }
  if (existing) {
    // 복구 — 장애 시각을 지우고, 밸브도 함께 걷는다 (21차: 핑 복구 시 자동 복귀.
    // 밸브는 장애 중에만 뜻이 있으므로 남겨 두면 다음 장애 때 낡은 우회가 되살아난다)
    await prisma.appSetting.deleteMany({
      where: { key: { in: [OUTAGE_SINCE_KEY, BYPASS_UNTIL_KEY] } },
    });
  }
}

/** 장애 시작 시각 — 없으면 장애 아님. 화면은 now − since 로 "N시간째"를 그린다 */
export async function getStudentOutageSince(prisma: PrismaClient): Promise<Date | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: OUTAGE_SINCE_KEY } });
  if (!row) return null;
  const since = new Date(row.value);
  return Number.isFinite(since.getTime()) ? since : null;
}

/**
 * 장애로 보류된 건수 (관리자 앱 2회차 B-2) — reviewer 문자열 LIKE 가 아니라
 * 전용 칼럼(studentAbsence)을 센다. 문구가 바뀌어도 0 으로 조용히 죽지 않는다.
 */
export async function countOutageHolds(prisma: PrismaClient): Promise<number> {
  return prisma.complianceReview.count({
    where: {
      studentAbsence: 'OUTAGE_HOLD',
      needsOperatorReview: true,
      operatorReviewedAt: null,
    },
  });
}

/** 띠지·관리 화면용 한 벌 — 조회 한 번으로 끝낸다 */
export async function getStudentOutageBoard(prisma: PrismaClient, now = new Date()) {
  const [since, holds, bypass] = await Promise.all([
    getStudentOutageSince(prisma),
    countOutageHolds(prisma),
    getStudentBypass(prisma, now),
  ]);
  return { outageSince: since, outageHolds: holds, bypass };
}
