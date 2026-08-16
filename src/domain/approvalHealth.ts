// 2인 승인의 습관화 감지 — **순수 규칙** (2026-08-16 검토 5차 Q1).
//
// 2인 승인의 사망 원인은 우회가 아니라 습관화다: "승인 좀 눌러줘"가 일상이 되는 순간
// 표만 남고 방어는 사라진다. 시간 지표 하나만 보면 굿하트의 법칙에 걸리므로(지표를
// 의식해 일부러 늦게 누르면 지표만 좋아진다) **성격이 다른 신호 셋을 함께** 본다 —
// 셋을 동시에 속이려면 결국 요청을 읽고 판단하는 척이 아니라 실제로 해야 한다.
//
//   ① 즉시 승인 비율 — 요청을 읽고 판단했다면 걸리는 시간이 있다
//   ② 반려율 0% 지속 — 표본이 쌓였는데 반려가 하나도 없으면 검토가 아니라 도장이다
//   ③ 연쇄 승인 — 몇 초 안에 여러 건이 연속 승인되면 본문을 읽지 않았다는 증거다

/** 요청→결정이 이보다 빠르면 "읽고 판단했다"고 보기 어렵다 @근거 설계 요약·사유·금액을 읽는 최소 시간 */
export const INSTANT_APPROVAL_SEC = 60;

/** 이 표본 위에서 반려 0%면 경고 @근거 설계 검토 5차 처방 — 50건 넘게 전부 승인이면 검토가 아니라 도장이다 */
export const ZERO_REJECT_MIN_DECIDED = 50;

/** 연쇄 클릭 판정 창 @근거 설계 검토 5차 처방 — 10초 안에 3건이면 본문을 읽지 않았다 */
export const BATCH_CLICK_WINDOW_SEC = 10;
/** 연쇄로 보는 최소 건수 @근거 설계 검토 5차 처방 — 정상 운영자도 두 건은 이어 볼 수 있다 */
export const BATCH_CLICK_MIN_COUNT = 3;

/** ①의 경고 문턱 — 절반 넘게 즉시 승인이면 시간 신호로도 습관이다 @근거 설계 초안, 운영 데이터로 재조정 */
export const INSTANT_RATIO_ALERT = 0.5;
/** ①에 경고를 걸 최소 표본 — 2~3건으로 비율을 말하면 오도다 @근거 설계 초안, 운영 데이터로 재조정 */
export const INSTANT_MIN_DECIDED = 10;

export interface ApprovalDecisionRow {
  requestedAt: Date;
  decidedAt: Date;
  decidedBy: string;
  /** APPROVED · EXECUTED(승인 후 소비됨) · REJECTED — 전부 "결정"이다 */
  status: string;
}

export interface ApprovalHealth {
  decided: number;
  rejected: number;
  /** 요청→결정 60초 미만 건수 */
  instant: number;
  /** 같은 승인자가 10초 창 안에 3건 이상 연속 승인한 횟수(겹치지 않는 구간 수) */
  batchRuns: number;
  /** 신호별 경고 */
  instantAlert: boolean;
  zeroRejectAlert: boolean;
  batchClickAlert: boolean;
  alert: boolean;
}

/**
 * 결정된 승인 행들로 습관화 신호를 계산한다.
 *
 * 연쇄 승인은 **승인자별로** 본다 — 두 운영자가 우연히 같은 시각에 각자 한 건씩
 * 처리한 것은 연쇄가 아니다. 반려는 연쇄에서 뺀다: 반려는 읽었다는 증거 쪽이다.
 */
export function assessApprovalHealth(rows: ApprovalDecisionRow[]): ApprovalHealth {
  const decided = rows.length;
  const rejected = rows.filter((r) => r.status === 'REJECTED').length;
  const instant = rows.filter(
    (r) => r.decidedAt.getTime() - r.requestedAt.getTime() < INSTANT_APPROVAL_SEC * 1000,
  ).length;

  // 승인자별로 승인(반려 제외)을 시간순으로 놓고, 10초 창에 3건 이상이 든 구간을 센다
  let batchRuns = 0;
  const byApprover = new Map<string, number[]>();
  for (const r of rows) {
    if (r.status === 'REJECTED') continue;
    const list = byApprover.get(r.decidedBy) ?? [];
    list.push(r.decidedAt.getTime());
    byApprover.set(r.decidedBy, list);
  }
  for (const times of byApprover.values()) {
    times.sort((a, b) => a - b);
    let i = 0;
    while (i < times.length) {
      let j = i;
      while (j + 1 < times.length && times[j + 1] - times[i] <= BATCH_CLICK_WINDOW_SEC * 1000) j++;
      if (j - i + 1 >= BATCH_CLICK_MIN_COUNT) {
        batchRuns++;
        i = j + 1; // 겹치는 구간을 두 번 세지 않는다
      } else {
        i++;
      }
    }
  }

  const instantAlert = decided >= INSTANT_MIN_DECIDED && instant / decided >= INSTANT_RATIO_ALERT;
  const zeroRejectAlert = decided >= ZERO_REJECT_MIN_DECIDED && rejected === 0;
  const batchClickAlert = batchRuns > 0;
  return {
    decided,
    rejected,
    instant,
    batchRuns,
    instantAlert,
    zeroRejectAlert,
    batchClickAlert,
    alert: instantAlert || zeroRejectAlert || batchClickAlert,
  };
}
