import { isStudentLabel, STUDENT_LABELS, type StudentLabel } from './studentText';
import type { RiskCategory } from './compliance';

// **교사가 준 답을 기록 가능한 값으로 바꾼다** (18차 V-3).
//
// ── 이 파일이 지켜야 하는 것 하나: 못 읽으면 지어내지 않는다 ──────────
// 사람이 대화창에서 복사해 붙이는 자리라 형식이 어긋날 수 있다. 그때 억지로
// 해석하면 **틀린 라벨이 그대로 학습 자료가 된다.** 못 읽으면 null 을 돌려주고
// 운영자가 손으로 고르게 하는 편이 낫다 — 손으로 고른 것은 적어도 사람이 본 것이다.
//
// ── 왜 `labels: []` 만으로는 부족한가 (11차 K-1 · 18차 V-3) ──────────
// 빈 배열은 "위반 없음"인데 그 안에 서로 다른 둘이 접혀 있다:
//   · **과함** — 애초에 잘못 잡았다 (오탐. **규칙**을 고쳐야 한다)
//   · **타당** — 지적은 맞는데 게시를 막을 정도는 아니다 (경미. **심각도**를 고쳐야 한다)
// 이 둘을 접으면 학생 모델 자동 격하가 무너진다 — 11차에 실측으로 드러났다:
// *"값이 둘뿐이면 무심코 누른 승인이 명시적 오탐 신고와 같아지고, 25건 중 6건이면
// 학생 모델이 영구히 꺼진다."* 그래서 한 줄을 더 받는다.

export interface TeacherAnswer {
  /** 교사가 지목한 유형. 빈 배열이면 "위반 없음" */
  labels: StudentLabel[];
  /**
   * 위반 없음일 때만 채워진다 — 1차 지적 **자체**가 타당했는가.
   * `true` 타당(경미) · `false` 과함(오탐) · `null` 위반이 있어서 물을 필요가 없음
   */
  findingsValid: boolean | null;
  /** 교사가 덧붙인 설명 (운영자가 읽는다. 없어도 된다) */
  note: string;
}

/** 답 형식이 어긋났을 때 운영자에게 보여줄 이유 — 무엇을 고쳐 달라고 해야 하는지 */
export type TeacherAnswerProblem =
  | 'NO_JSON'
  | 'BAD_JSON'
  | 'ID_MISMATCH'
  | 'BAD_LABELS'
  | 'MISSING_VALIDITY';

export interface TeacherAnswerParse {
  answer: TeacherAnswer | null;
  problem: TeacherAnswerProblem | null;
}

/** 답안 id — 어느 검수 건의 답인지가 문자열 자체에 남는다 */
export function teacherPackId(reviewId: string): string {
  return `review:${reviewId}`;
}

/**
 * 교사 답을 파싱한다. **못 읽으면 `answer: null`** — 이유를 함께 돌려준다.
 *
 * @param expectedId 이 답이 어느 건의 것이어야 하는가. **반드시 대조한다** —
 *   한 대화창에서 여러 건을 물으면 운영자가 **앞 건의 답을 복사할 수 있다**(18차 V-6).
 *   id 가 안 맞으면 통째로 거절한다: 엉뚱한 건의 라벨이 붙는 것이 못 읽는 것보다 나쁘다.
 */
export function parseTeacherAnswer(text: string, expectedId: string): TeacherAnswerParse {
  const fail = (problem: TeacherAnswerProblem): TeacherAnswerParse => ({ answer: null, problem });

  // JSON 한 줄을 찾는다. 대화창은 ```로 감싸 주기도 하고 앞뒤에 설명을 붙이기도 한다
  const m = text.match(/\{[^{}]*"id"\s*:[^{}]*\}/);
  if (!m) return fail('NO_JSON');

  let parsed: unknown;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return fail('BAD_JSON');
  }
  const obj = parsed as { id?: unknown; labels?: unknown };

  if (typeof obj.id !== 'string' || obj.id.trim() !== expectedId) return fail('ID_MISMATCH');
  if (!Array.isArray(obj.labels)) return fail('BAD_LABELS');

  // **모르는 라벨이 하나라도 있으면 통째로 거절한다.** 조용히 버리면 교사가 지목한
  // 위반이 사라진 채 "위반 없음"이 되어 학습이 뒤집힌다
  const labels: StudentLabel[] = [];
  for (const raw of obj.labels) {
    if (typeof raw !== 'string') return fail('BAD_LABELS');
    const up = raw.trim().toUpperCase() as RiskCategory;
    if (!isStudentLabel(up)) return fail('BAD_LABELS');
    if (!labels.includes(up)) labels.push(up);
  }

  // 위반이 있으면 "지적이 과했나"를 물을 이유가 없다 — 지적은 옳았다
  if (labels.length > 0) {
    return { answer: { labels, findingsValid: null, note: noteOf(text, m[0]) }, problem: null };
  }

  const validity = text.match(/^\s*지적\s*[:：]\s*(.+)$/m)?.[1]?.trim();
  // 위반 없음인데 이 줄이 없으면 **오탐과 경미를 못 가른다.** 지어내지 않는다
  if (!validity) return fail('MISSING_VALIDITY');

  // **부분 일치로 읽으면 안 된다.** `타당하지 않음` 이 `타당`을 품고 있어서
  // 포함 검사로는 **정반대로 읽힌다** — 그리고 그 라벨이 그대로 학습에 들어간다.
  // 형식은 질문지가 못 박아 준 두 낱말뿐이라, 그 둘이 아니면 사람이 고르게 한다
  const bare = validity.replace(/[.。!?]\s*$/, '');
  if (bare !== '타당' && bare !== '과함') return fail('MISSING_VALIDITY');

  return {
    answer: { labels, findingsValid: bare === '타당', note: noteOf(text, m[0]) },
    problem: null,
  };
}

/** JSON 줄과 `지적:` 줄을 뺀 나머지가 교사의 설명이다 */
function noteOf(text: string, jsonLine: string): string {
  return text
    .replace(jsonLine, '')
    .split('\n')
    .filter((l) => !/^\s*지적\s*[:：]/.test(l) && !/^\s*```/.test(l))
    .join('\n')
    .trim()
    .slice(0, 2000);
}

export const TEACHER_ANSWER_PROBLEM_MESSAGE: Record<TeacherAnswerProblem, string> = {
  NO_JSON: '답에서 JSON 한 줄을 찾지 못했습니다. `{"id":"review:...","labels":[...]}` 줄을 함께 붙여 넣어 주세요.',
  BAD_JSON: 'JSON 줄의 형식이 깨져 있습니다. 대화창의 답을 그대로 다시 복사해 주세요.',
  ID_MISMATCH:
    '다른 검수 건의 답입니다 — id가 이 건과 다릅니다. **앞 건의 답을 복사하지 않았는지** 확인해 주세요.',
  BAD_LABELS: `모르는 유형이 섞여 있습니다. 쓸 수 있는 유형: ${STUDENT_LABELS.join(' · ')}`,
  MISSING_VALIDITY:
    '위반이 없다는 답인데 `지적: 타당` 또는 `지적: 과함` 줄이 없습니다. 이 한 줄이 오탐과 경미를 가릅니다.',
};
