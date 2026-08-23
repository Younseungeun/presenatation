import { REPUBLISH_REVIEW_THRESHOLD, type Finding } from './compliance';

// **모든 보류를 물어볼 수는 없다 — 무엇을 반드시 물을 것인가** (18차 V-7).
//
// ── 병목이 만든 문제 ─────────────────────────────────────────────────
// 자동 2차는 초당 여러 건이었지만 수동은 건당 1~2분이고 운영자는 1~2인이다.
// 큐가 밀리면 가장 나쁜 결말이 온다 — **안 물어보고 그냥 승인.** 라벨은 남는데 근거가
// 없고, 그 라벨이 학습셋에 섞인다. 조용히 일어나서 결과만 보면 정상 운영과 같다.
//
// 처방은 처리량을 늘리는 것이 아니라 **무엇을 반드시 물을지 정하는 것**이다.
// 검토의 답: *"심각도(BLOCK)와 리서처 등급(신규/위험 리서처)을 기준으로 강제하라."*
//
// ── 안 물어본 건의 기본값은 승인이다 ─────────────────────────────────
// λ=4 아래에서 확인 없이 반려하면 오탐 비용이 그대로 나간다. 확인 없이 승인하면
// 미탐 하나를 감수하는데, 그쪽이 4분의 1이다. **모르면 통과시키는 쪽으로 기운다** —
// 이 시스템의 다른 모든 자리와 같은 방향이다.

export interface AskPolicyInput {
  findings: readonly Finding[];
  /** 이 리서처가 판정을 받은 카드 수. 0이면 신규다 */
  judgedCardCount: number;
  /** 반려·철회 이력 — 규칙을 이진 탐색하던 이력이 있으면 사람이 한 번 더 본다 */
  rejectionCount: number;
}

export type AskRequirement = 'REQUIRED' | 'OPTIONAL';

export interface AskDecision {
  requirement: AskRequirement;
  /** 화면이 그대로 보여줄 이유 — "왜 이 건은 반드시 물어야 하나" */
  reason: string;
}

/**
 * 신규 리서처의 문턱 — 판정 카드가 이만큼 미만이면 이력이 없다고 본다.
 *
 * @근거 설계 — 3은 "우연이 아니다"를 만드는 최소치다. 한 장은 운일 수 있고 두 장도
 *   그렇다. 트랙레코드가 없는 사람의 첫 글들이 이 플랫폼에서 가장 위험한 자리라
 *   (평판으로 거를 수 없다) 그 구간만 사람이 반드시 본다.
 */
export const NEW_RESEARCHER_JUDGED_CARDS = 3;

/**
 * 재제출 이력의 문턱 — **`REPUBLISH_REVIEW_THRESHOLD` 그 자체다** (Q11 · 2026-08-21).
 *
 * 처음에는 같은 값 3을 별도 상수로 뒀는데, 그러면 한쪽만 바뀌는 날
 * "보류는 되는데 교사에게 안 묻는"(또는 그 반대) 상태가 조용히 생긴다.
 * "문구만 바꿔 재제출하며 규칙을 이진 탐색한다"고 본 지점이라면 교사도 봐야 하고,
 * 그 두 판단의 문턱은 정의상 하나다.
 */
export const REPEAT_REJECTION_THRESHOLD = REPUBLISH_REVIEW_THRESHOLD;

/**
 * 이 보류 건을 **반드시** 교사에게 물어야 하는가.
 *
 * `OPTIONAL` 은 "묻지 말라"가 아니라 **"큐가 밀리면 운영자 단독으로 처리해도 된다"**는
 * 뜻이다. 여유가 있으면 전부 묻는 것이 낫다 — 라벨이 그만큼 늘어난다.
 */
export function teacherAskRequirement(input: AskPolicyInput): AskDecision {
  // ① 규칙이 명백한 위반이라고 본 건. 처분이 가장 무거워 판단이 틀리면 대가가 크다
  if (input.findings.some((f) => f.severity === 'BLOCK')) {
    return {
      requirement: 'REQUIRED',
      reason: '규칙이 명백한 위반으로 봤고, 처분이 무거워 한 번 더 봅니다',
    };
  }

  // ② 트랙레코드가 없는 리서처. 평판으로 거를 수 없는 유일한 구간이다
  if (input.judgedCardCount < NEW_RESEARCHER_JUDGED_CARDS) {
    return {
      requirement: 'REQUIRED',
      reason: `판정 이력이 ${input.judgedCardCount}건뿐이라 평판으로 거를 수 없습니다`,
    };
  }

  // ③ 반려를 반복하며 문구를 고쳐 오는 이력. 규칙을 더듬고 있을 수 있다
  if (input.rejectionCount >= REPEAT_REJECTION_THRESHOLD) {
    return {
      requirement: 'REQUIRED',
      reason: `반려 ${input.rejectionCount}회 이력이라 문구만 바꿔 재제출하는 중일 수 있습니다`,
    };
  }

  return {
    requirement: 'OPTIONAL',
    reason: '큐가 밀리면 운영자 단독으로 처리해도 됩니다 (안 물어보면 승인 쪽으로)',
  };
}
