// 거절 훑기 큐 · 거절 이의 (B1, 12차 검토 C-6 부분 채택, 2026-09-01) — 순수 로직.
//
// 즉시 거절(규칙 BLOCK)은 큐에 안 와 사람 판정이 안 붙는다. 그래서 BLOCK 규칙은 오탐 증거
// 채널이 0이었고, 사다리 집계(operatorVerdict 가 붙은 기록만 센다)에 영영 안 나타났다.
// 두 통로로 그 기록에 판정을 붙인다:
//   · 운영자 거절 훑기 — 판정 없는 BLOCK 기록을 **규칙별 최근 N건 표본**으로 띄워 정탐/오탐만 찍는다.
//     전수가 아니라 표본인 이유: 오탐 0 을 주장하려면 규칙마다 표본이 있어야 하고, 1인 운영이
//     매일 전수를 훑을 수는 없다. 이의가 붙은 건은 표본과 무관하게 전부·맨 앞.
//   · 리서처 이의 — "억울하다"는 낼 수 없고 **인용문이 어떤 문맥이었는지** 소명해야 접수된다
//     (판정 이의가 "맞다고 보는 가격"을 요구하는 것과 같은 구조). 상한 셋이 이진 탐색 통로가
//     되는 것을 막는다.
// **자동 강등은 없다** — 확정 오탐이면 즉시 재학습, 내리는 판단은 창업자 수동(T10).
// 거절 문구(인용문) 비공개 제안은 기각 — 리서처가 고칠 수 있게 하는 의도된 설계다.

import { REPUBLISH_REVIEW_THRESHOLD } from './compliance';

/** @근거 설계 규칙별 표본 — 오탐 0 을 말하려면 규칙마다 최근 몇 건은 사람이 봐야 한다. 5는 하루 1인이 감당하는 선(초안) */
export const REJECT_AUDIT_SAMPLE_PER_RULE = 5;
/** @근거 설계 소명 하한 — 검토자 제안 50자 → 30자: "이 인용문은 ~한 문맥이다" 한 문장의 최소치. 한 낱말 소명만 막는다 */
export const APPEAL_MIN_STATEMENT = 30;
/** @근거 설계 리서처당 미결 이의 상한 — 판정 이의의 "카드 상한이 곧 상한" 원리. 2건이면 동시에 두 규칙의 경계를 더듬을 수 없다 */
export const APPEAL_MAX_OPEN = 2;
/** 반려 누적이 이 값이면 창구가 닫힌다 — 이미 사람 검토로 넘어간 리서처(REPUBLISH_REVIEW_THRESHOLD)다 */
export const APPEAL_CLOSED_AT_REJECTIONS = REPUBLISH_REVIEW_THRESHOLD;

export type AppealDenial = 'ALREADY_APPEALED' | 'ALREADY_AUDITED' | 'TOO_MANY_OPEN' | 'CLOSED_BY_REJECTIONS' | 'TOO_SHORT';

export function checkAppealAllowed(input: {
  alreadyAppealed: boolean;
  /** 운영자가 이미 정탐/오탐을 찍은 건 — 이의는 판정 전에만 */
  alreadyAudited: boolean;
  openAppeals: number;
  rejectionCount: number;
  statement: string;
}): { ok: true } | { ok: false; reason: AppealDenial; message: string } {
  if (input.alreadyAudited) {
    return { ok: false, reason: 'ALREADY_AUDITED', message: '운영자가 이미 확인한 거절입니다 — 이의는 확인 전에만 낼 수 있습니다' };
  }
  if (input.alreadyAppealed) {
    return { ok: false, reason: 'ALREADY_APPEALED', message: '이 거절에는 이미 이의를 냈습니다 — 거절 1건에 이의는 1회입니다' };
  }
  if (input.rejectionCount >= APPEAL_CLOSED_AT_REJECTIONS) {
    return {
      ok: false,
      reason: 'CLOSED_BY_REJECTIONS',
      message: `반려가 ${APPEAL_CLOSED_AT_REJECTIONS}회 이상 누적된 리포트는 이의 대신 운영자가 직접 검토합니다 — 그대로 제출하면 사람이 봅니다`,
    };
  }
  if (input.openAppeals >= APPEAL_MAX_OPEN) {
    return { ok: false, reason: 'TOO_MANY_OPEN', message: `확인을 기다리는 이의가 ${APPEAL_MAX_OPEN}건입니다 — 결과가 나온 뒤 다시 낼 수 있습니다` };
  }
  if (input.statement.trim().length < APPEAL_MIN_STATEMENT) {
    return {
      ok: false,
      reason: 'TOO_SHORT',
      message: `걸린 인용문이 어떤 문맥이었는지 ${APPEAL_MIN_STATEMENT}자 이상 적어 주세요 (예: "면책 문구로 '보장하지 않는다'고 쓴 것")`,
    };
  }
  return { ok: true };
}

export interface RejectAuditCandidate {
  reviewId: string;
  /** BLOCK 소견을 낸 규칙 id 들 */
  ruleIds: string[];
  appealed: boolean;
  createdAt: Date;
}

/**
 * 훑기 표본 — 이의 붙은 건은 전부 맨 앞(최신순), 그 다음 규칙별 최근 N건. 같은 건이 여러 규칙에
 * 걸렸으면 한 번만. 입력 순서는 무관(안에서 정렬).
 */
export function sampleRejectAudit<T extends RejectAuditCandidate>(items: T[], perRule = REJECT_AUDIT_SAMPLE_PER_RULE): T[] {
  const sorted = [...items].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const out: T[] = [];
  const seen = new Set<string>();
  for (const it of sorted) {
    if (it.appealed && !seen.has(it.reviewId)) {
      out.push(it);
      seen.add(it.reviewId);
    }
  }
  const perRuleCount = new Map<string, number>();
  for (const it of sorted) {
    if (seen.has(it.reviewId)) continue;
    // 이 건이 걸린 규칙 중 하나라도 표본이 덜 찼으면 싣는다
    const wanted = it.ruleIds.some((r) => (perRuleCount.get(r) ?? 0) < perRule);
    if (!wanted) continue;
    out.push(it);
    seen.add(it.reviewId);
    for (const r of it.ruleIds) perRuleCount.set(r, (perRuleCount.get(r) ?? 0) + 1);
  }
  return out;
}
