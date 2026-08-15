import type { PrismaClient } from '@prisma/client';
import { AUDIT_ACTIONS, type AuditAction } from './auditLog';
import { notifyOperators } from './opsAlert';

// **고위험 행위가 일어나면 즉시 밖으로 쏜다** (2026-08-15).
//
// ── 왜 화면이 아니라 알림인가 (외부 검토 반영) ───────────────
// 감사 로그 전용 화면을 만들려다 접었다. 필터를 actor·action·기간으로 좁히면 그건
// 사실상 **운영자 감시 화면**인데, 1인 운영에서 자기가 자기를 감시하는 화면은
// **아무도 자발적으로 열지 않는 죽은 코드**가 된다. 화면은 운영자가 둘 이상이 되고
// 내부 통제 요구가 생길 때 만든다.
//
// 대신 사건이 **사람을 찾아가게** 한다. 세션이 털렸다면 그 사실을 아는 시점이 빠를수록
// 피해가 작고, 어드민 화면을 열어 보는 것보다 휴대폰 알림이 빠르다.
// 전송은 이미 있는 `notifyOperators`가 한다(인앱 + 웹훅, 실패해도 안 던진다) —
// 여기서 웹훅을 다시 구현하면 형식·타임아웃·중복 억제가 두 벌이 된다.
//
// ── 왜 호출부에서 쏘지 않고 감사 로그에서 끌어오나 ───────────
// 고위험 행위마다 알림을 부르게 하면 **여섯 곳 중 한 곳은 반드시 빠지고**, 빠진 그
// 한 곳이 정확히 공격자가 쓰는 경로가 된다. 감사 로그는 이미 모든 사건이 지나가는
// 단일 통로이므로 **거기서 파생**시키면 빠질 자리가 없다.
//
// 부수 효과 하나가 결정적이다: **CLI에서 한 일도 알림이 간다.** 일괄 롤백은 웹이 아니라
// 셸에서 도는데, 호출부 방식이었다면 그 경로에 알림을 따로 붙였어야 한다.
//
// ── 커서를 AppSetting에 두는 이유 ────────────────────────────
// AuditLog에 `alertedAt`을 달면 **append-only가 깨진다**(그 표의 첫 번째 규칙이다).
// 갱신할 수 있는 감사 로그는 증명이 못 된다. 그래서 "어디까지 보냈나"는 밖에 적는다.

const CURSOR_KEY = 'ops.alert.cursor';

/**
 * 밖으로 쏠 사건 — **돈이 나가거나, 되돌릴 수 없거나, 권한이 바뀌는 것**만.
 *
 * 자동 판정은 애초에 감사 로그에 들어오지 않으므로 여기서 거를 것도 없다
 * (auditLog.ts의 "평화로울 때 침묵한다").
 *
 * **수동 판정은 들어간다** — 하루 몇 건이라 소음이 아니고, 무엇보다 탈취된 세션이
 * 돈에 닿는 가장 짧은 길이 "가짜 적중을 매겨 지급 지시서를 만드는 것"이다.
 * 정산 쿨다운(settlementCooldown)이 24시간을 벌어 주는데, 그 시간이 의미를 가지려면
 * 그 사이에 사람이 **알아야** 한다.
 */
export const HIGH_RISK_ACTIONS: AuditAction[] = [
  'PAYOUT_EXECUTED',
  'REFUND_EXECUTED',
  'JUDGMENT_REVERTED',
  'MANUAL_JUDGMENT',
  'BULK_REVERT',
  'PURCHASE_VOIDED',
  'JUDGMENT_PAUSE_SET',
  'ROLE_CHANGED',
];

/** 한 회차에 보낼 최대 건수 — 사고로 수백 건이 나도 알림이 폭주하지 않게 */
const MAX_PER_FLUSH = 20;

function body(row: {
  at: Date;
  actor: string;
  actorType: string;
  targetType: string;
  targetId: string;
  reason: string | null;
}): string {
  return (
    `누가: ${row.actor} (${row.actorType})\n` +
    `대상: ${row.targetType} ${row.targetId}\n` +
    `시각: ${row.at.toISOString()}` +
    (row.reason ? `\n사유: ${row.reason}` : '')
  );
}

/**
 * 마지막으로 보낸 이후의 고위험 사건을 내보낸다. 스케줄러가 매 틱 부른다.
 */
export async function flushOpsAlerts(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ sent: number }> {
  const cursorRow = await prisma.appSetting.findUnique({ where: { key: CURSOR_KEY } });

  // **처음 도는 경우엔 과거를 쏟아내지 않는다** — 커서만 지금으로 세운다.
  // 없으면 배포 직후 그동안의 모든 지급이 한꺼번에 날아간다
  if (!cursorRow) {
    await prisma.appSetting.create({
      data: { key: CURSOR_KEY, value: now.toISOString(), updatedBy: 'system' },
    });
    return { sent: 0 };
  }

  const rows = await prisma.auditLog.findMany({
    where: { at: { gt: new Date(cursorRow.value) }, action: { in: HIGH_RISK_ACTIONS } },
    orderBy: { at: 'asc' },
    take: MAX_PER_FLUSH,
  });
  if (rows.length === 0) return { sent: 0 };

  for (const row of rows) {
    await notifyOperators(prisma, {
      title: `고위험 작업: ${AUDIT_ACTIONS[row.action as AuditAction] ?? row.action}`,
      body: body(row),
      link: '/admin/settings',
      type: 'OPS_ALERT',
      // 같은 사건을 두 번 쏘지 않는다 — 커서가 이미 막지만, 커서 갱신이 실패한 회차의
      // 재시도까지 여기서 걸러진다
      dedupeKey: `audit:${row.id}`,
    });
  }

  // **보낸 뒤에 커서를 옮긴다** — 먼저 옮기면 전송 실패가 곧 유실이다.
  // (전송은 안 던지므로 실패해도 여기까지 온다 — 그건 notifyOperators의 설계다)
  await prisma.appSetting.update({
    where: { key: CURSOR_KEY },
    data: { value: rows[rows.length - 1].at.toISOString() },
  });

  return { sent: rows.length };
}

/**
 * 하루에 이만큼 넘게 상한 환불이 나가면 알린다.
 *
 * 상한(14일) 환불은 정상 운영에서 **거의 0건**이다 — 시세를 못 구한 카드가 2주를
 * 채우는 일이 드물기 때문. 그래서 문턱을 낮게 잡아도 소음이 되지 않고, 반대로
 * 이 숫자가 두 자리로 뛰는 것은 언제나 무언가 고장 났다는 뜻이다.
 */
const HARD_CAP_SURGE_PER_DAY = 10;

/**
 * **조용히 대량으로 나가는 환불을 잡는다** (2026-08-15).
 *
 * 상한 환불은 사람이 실행하는 것이 아니라 시스템이 닫는 것이라 `REFUND_EXECUTED`
 * 감사 기록이 남지 않는다 — 지시서만 만들어진다. 그래서 위의 고위험 알림 경로에
 * 걸리지 않고, 회차당 20장씩 매 틱 조금씩 나가면 **총량은 일일 한도 안인데 아무도
 * 지금 무슨 일이 벌어지는지 모른다.**
 *
 * 특히 자동 판정을 정지해 둔 동안 이것이 유일하게 계속 도는 경로다(상한은 구매자
 * 약속이라 정지 중에도 집행한다 — judgmentBatch.sweepHardCappedWhilePaused).
 * 정지가 길어질수록 조용히 늘어나는 구조라, 정지를 건 사람에게 그 사실이 돌아가야 한다.
 *
 * **알림이 요구하는 결정은 "정지를 풀까"가 아니다** — 고장 난 시세를 다시 들이마시는
 * 것이 답일 수는 없다. 공지를 띄울까, 개별로 연락할까 쪽이다.
 */
export async function flushHardCapSurgeAlert(
  prisma: PrismaClient,
  now = new Date(),
): Promise<{ alerted: boolean; count: number }> {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  const count = await prisma.judgment.count({
    where: { judgedAt: { gte: from }, dataSource: { startsWith: 'hard-cap' } },
  });
  if (count < HARD_CAP_SURGE_PER_DAY) return { alerted: false, count };

  const paused = await prisma.judgment.count({
    where: { judgedAt: { gte: from }, dataSource: 'hard-cap:paused' },
  });

  await notifyOperators(prisma, {
    title: `상한 환불 급증: 오늘 ${count}건`,
    body:
      `시한 후 14일을 넘겨 자동으로 전액 환불된 카드가 오늘 ${count}건입니다` +
      (paused > 0 ? ` (그중 ${paused}건은 자동 판정 정지 중 발생).` : '.') +
      `\n판정을 못 한 원인이 아직 살아 있다는 뜻이고, 구매자에게는 이미 돈이 돌아가는 중입니다.` +
      `\n정지를 푸는 것이 아니라 **공지·개별 연락**을 결정할 자리입니다.`,
    link: '/admin/judgments',
    type: 'OPS_ALERT',
    // **하루 한 번** — 매 틱 같은 사실을 반복하면 그 자체가 소음이 된다
    dedupeKey: `hardcap-surge:${from.toISOString().slice(0, 10)}`,
  });

  return { alerted: true, count };
}
