import type { Prisma, PrismaClient } from '@prisma/client';

// 감사 로그 — **돈이 움직였거나 돈의 근거가 바뀐 사건**만 남긴다 (2026-08-15).
//
// ── 왜 도메인 표로 충분하지 않은가 ───────────────────────────
// 되돌리기는 JudgmentRevert에, 검수 판정은 ComplianceReview에, 환불 실행은
// RefundAttempt에 이미 남는다. 그런데 그것들은 전부 **각 도메인의 상태**를 관리하는
// 표다 — 스키마가 바뀌고, 백필이 돌고, 행이 지워진다(판정 되돌리기는 Judgment 행을
// 실제로 지운다). 분쟁에서 요구받는 것은 **"특정 시점에 무엇이 왜 바뀌었는가"의
// 절대적 순서**이고, 표 다섯 개를 조인해 만든 뷰는 그걸 증명하지 못한다.
//
// 중복은 비용이 아니라 **정합성 검증의 재료**다. 둘이 어긋나는 날이 오면 그 자체가
// 시스템 이상 신호다.
//
// ── 사건 하나에 한 줄 ────────────────────────────────────────
// 판정 한 번이 정산 3건·구매 3건·알림 3건을 만들어도 로그는 **한 줄**이다.
// "정산 s_1이 왜 생겼나"를 물으면 감사 로그를 뒤지는 것이 아니라
// **도메인 외래키를 타고 올라와** targetId로 조회한다:
//
//     Settlement(s_1) → Purchase → Report → PredictionCard → Judgment(j_9)
//     → AuditLog where targetType='Judgment' and targetId='j_9'   ← 인덱스 한 번
//
// 하위 id 목록을 JSON에 담아 검색하게 만들면 **SQLite에는 JSON 인덱스가 없어
// 풀스캔**이 된다. 로그가 커질수록 정확히 필요한 순간에 못 쓰게 된다.
//
// ⚠ 되돌린 판정은 Judgment 행이 사라져 위 경로가 끊긴다 — 그쪽은 JudgmentRevert가
// 원래 judgmentId를 보관하므로 거기서 이어 붙인다(그 표가 존재하는 이유이기도 하다).
//
// ── 트랜잭션에 얹는다 ────────────────────────────────────────
// `auditOp`는 실행하지 않고 **쓰기 연산을 돌려준다.** 호출자가 자기 트랜잭션 배열에
// 끼워 넣으므로 기록과 변경이 **함께 커밋되거나 함께 사라진다.** 따로 await하면
// "돈은 움직였는데 기록은 없는" 창이 생기고, 그 창이 정확히 분쟁이 나는 자리다.

export type AuditActorType = 'OPERATOR' | 'SYSTEM' | 'USER';

/**
 * 남기는 사건의 목록 — **여기 없는 것은 안 남긴다.**
 * 목록을 열어 두면 인프라 오류·조회 로그가 섞여 들어와 검색되지 않는 크기로 자란다.
 *
 * ── 평화로울 때 침묵한다 (2026-08-15, 외부 검토 반영) ────────
 * 처음에는 자동 판정도 남겼다. 근거는 "에스크로가 갈라지는 순간이니 돈의 근거가
 * 바뀐 사건"이었는데, 그 기준으로는 **정상 하루치 수백 건이 전부 여기 들어온다.**
 * 그러면 정작 찾아야 할 개입(되돌리기·정지·권한 변경)이 소음에 묻힌다.
 *
 * 감사 로그가 답하는 질문은 "무슨 일이 있었나"가 아니라 **"누가 끼어들었나"**다.
 * 도메인 표가 이미 완전한 기록인 사건(Judgment 행에는 결과·시세 스냅샷·시각이 전부
 * 있다)을 복사하는 것은 이벤트 소싱이지 감사가 아니다.
 */
export const AUDIT_ACTIONS = {
  /**
   * 사람이 직접 판정을 매겼다 — 자동 배치가 아니라 운영자가 시세를 입력하거나
   * 판정 불가로 닫은 경우 (manualJudgmentService).
   *
   * **자동 판정은 여기 없다** (2026-08-15, 외부 검토 반영). 아래 "평화로울 때
   * 침묵한다"를 보라 — 다만 자르는 선은 *행위*가 아니라 **행위자**다.
   * 같은 Judgment 행을 만드는 일이어도 배치가 하면 도메인 흐름이고 사람이 하면
   * 개입이다. 그리고 탈취된 세션이 돈에 닿는 **가장 빠른 경로**가 정확히 이것이다:
   * 가짜 적중을 매겨 지급 지시서를 만드는 것. 그래서 고위험 알림 목록에도 들어간다
   */
  MANUAL_JUDGMENT: '수동 판정',
  /** 판정을 없던 일로 되돌렸다 */
  JUDGMENT_REVERTED: '판정 되돌리기',
  /** 리서처에게 지급을 실행했다 */
  PAYOUT_EXECUTED: '리서처 지급 실행',
  /** 구매자에게 환불을 실행했다 */
  REFUND_EXECUTED: '구매자 환불 실행',
  /** CS 환불로 거래 자체를 무효화했다 */
  PURCHASE_VOIDED: 'CS 환불·거래 무효화',
  /** 판정 이의를 확정했다 (인정·기각) */
  DISPUTE_RESOLVED: '판정 이의 확정',
  /** 종목 위험 등급을 사람이 바꿨다 — 판매 가능 여부가 바뀐다 */
  INSTRUMENT_RISK_SET: '종목 위험 등급 변경',
  /** 자동 판정을 멈추거나 다시 열었다 */
  JUDGMENT_PAUSE_SET: '자동 판정 정지·해제',
  /** 판정을 회차 단위로 일괄 되돌렸다 */
  BULK_REVERT: '판정 일괄 되돌리기',
  /** 운영자 권한을 주거나 뺏었다 */
  ROLE_CHANGED: '운영자 권한 변경',
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export interface AuditEntry {
  actor: string;
  actorType: AuditActorType;
  action: AuditAction;
  targetType: string;
  targetId: string;
  /** 바뀌기 전/후의 **핵심 상태 필드만** — 객체 트리를 통째로 담지 않는다 */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string;
  at?: Date;
}

const json = (v: Record<string, unknown> | undefined) => (v === undefined ? null : JSON.stringify(v));

/**
 * 감사 기록 **쓰기 연산**을 만든다 (실행하지 않는다).
 *
 * 반드시 변경과 **같은 트랜잭션**에 넣어라:
 *
 *     await prisma.$transaction([ ...writes, auditOp(prisma, entry) ]);
 *
 * 따로 실행하면 변경은 커밋됐는데 기록이 실패하는 창이 열린다.
 */
export function auditOp(prisma: PrismaClient, entry: AuditEntry): Prisma.PrismaPromise<unknown> {
  return prisma.auditLog.create({
    data: {
      actor: entry.actor,
      actorType: entry.actorType,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: json(entry.before),
      after: json(entry.after),
      reason: entry.reason ?? null,
      ...(entry.at ? { at: entry.at } : {}),
    },
  });
}

/** 트랜잭션 밖에서 남겨야 하는 드문 경우 (CLI 등) — 기본은 `auditOp`다 */
export async function audit(prisma: PrismaClient, entry: AuditEntry): Promise<void> {
  await auditOp(prisma, entry);
}

/**
 * 도메인 표에서 끌어온 줄에만 붙는 행위 — **감사 로그에는 절대 안 들어간다.**
 * `AUDIT_ACTIONS`와 분리해 두는 것이 그 사실을 타입으로 못 박는다
 * (auditOp의 action은 AuditAction만 받는다).
 */
export const DERIVED_ACTIONS = {
  AUTO_JUDGMENT: '자동 판정',
} as const;

export const TRAIL_LABELS: Record<string, string> = { ...AUDIT_ACTIONS, ...DERIVED_ACTIONS };

/** 이력 한 줄 — 감사 로그 행이거나, 도메인 표에서 끌어온 행이거나 */
export interface TrailEntry {
  at: Date;
  actor: string;
  actorType: AuditActorType;
  action: AuditAction | keyof typeof DERIVED_ACTIONS;
  targetType: string;
  targetId: string;
  reason: string | null;
  before: string | null;
  after: string | null;
  /** 감사 로그 행이 아니라 도메인 표에서 합친 줄인가 */
  derived: boolean;
}

/**
 * 한 대상의 이력 — 오래된 순.
 * 화면·조사 모두 "이 카드에 무슨 일이 있었나"를 시간 순으로 읽는다.
 *
 * **자동 판정은 감사 로그에 없으므로 여기서 합친다** (2026-08-15). 로그에 복사본을
 * 두지 않는 대신, 타임라인의 첫 줄("판정이 났다")은 `Judgment` 행에서 조회 시점에
 * 끌어온다. 기록을 두 곳에 쓰는 것과 두 곳에서 읽는 것은 다르다 — 쓰기를 나누면
 * 어긋날 수 있지만, 읽기를 합치는 것은 어긋날 자리가 없다.
 *
 * 되돌려진 판정은 `Judgment` 행이 사라져 이 줄도 함께 사라진다. 그 경우의 첫 줄은
 * 감사 로그의 `JUDGMENT_REVERTED`가 맡고, 원래 판정의 내용은 JudgmentRevert가
 * 보관한다(그 표가 존재하는 이유다).
 */
export async function getAuditTrail(
  prisma: PrismaClient,
  targetType: string,
  targetId: string,
): Promise<TrailEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: { targetType, targetId },
    orderBy: { at: 'asc' },
  });

  const entries: TrailEntry[] = rows.map((r) => ({
    at: r.at,
    actor: r.actor,
    actorType: r.actorType as AuditActorType,
    action: r.action as AuditAction,
    targetType: r.targetType,
    targetId: r.targetId,
    reason: r.reason,
    before: r.before,
    after: r.after,
    derived: false,
  }));

  if (targetType === 'PredictionCard') {
    const j = await prisma.judgment.findUnique({
      where: { predictionCardId: targetId },
      select: { outcome: true, settledPrice: true, dataSource: true, judgedAt: true },
    });
    // 수동 판정은 감사 로그에 이미 한 줄 있다 — 두 번 그리지 않는다
    if (j && !j.dataSource?.startsWith('manual:')) {
      entries.push({
        at: j.judgedAt,
        actor: `system:${j.dataSource ?? 'unknown'}`,
        actorType: 'SYSTEM',
        action: 'AUTO_JUDGMENT',
        targetType,
        targetId,
        reason: null,
        before: null,
        after: JSON.stringify({ outcome: j.outcome, settledPrice: j.settledPrice }),
        derived: true,
      });
    }
  }

  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}
