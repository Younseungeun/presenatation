import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COHERENCE_CORPUS } from './__fixtures__/coherenceCorpus';
import { SCREENING_CORPUS } from './__fixtures__/screeningCorpus';
import { applyRules } from './compliance';
import { evaluate } from './screeningEval';

// **역할 분담을 문서가 아니라 시험으로 붙잡는다** (10차 검토 I-2).
//
// ── 무엇이 문제였나 ──────────────────────────────────────────────
// 규칙과 학생이 서로 다른 자리를 메우고 있다는 것은 설계가 아니라 **데이터 구성의
// 부작용**이다. 합성 학습 코퍼스에는 직설(literal) 예시가 **한 건도 없고**
// (paraphrase 210 · hard_negative 175 · normal 60), 그래서 학생의 직설 탐지가 50%다.
// 규칙이 그 자리를 100% 덮고 있어 **합산에서는 아무 증상이 없다.**
//
// 위험은 정확히 여기 있다: 규칙 정규식을 좁히는 날 — 오탐이 성가시다는 이유로 언젠가
// 반드시 좁힌다 — 학생이 못 받는 자리가 그대로 구멍이 된다. 그때 합산 탐지율은
// 떨어지는데, 떨어진 이유는 "규칙을 고쳤기 때문"이 아니라 **"학생이 배운 적 없는
// 것을 규칙에게만 맡겨 뒀기 때문"**이라 원인을 되짚기 어렵다.
//
// ── 왜 학생을 더 가르치지 않고 시험으로 막나 ─────────────────────
// 학생에게 직설을 가르치는 것도 답이지만, 그건 규칙이 이미 100%인 자리에 모델 용량을
// 쓰는 것이다. 검토의 답이 더 낫다: **문서에 남겨 잊히기를 기다리지 말고,
// 배포를 막는 조건으로 물리화하라.**
//
// ── 두 층으로 나눈 이유 ──────────────────────────────────────────
// 라쳇의 본체는 **합산 커버리지**다(운영에서 실제로 노출되는 값). 그런데 합산을 재려면
// 사이드카가 살아 있어야 해서 `npm test`에서는 못 잰다. 그래서:
//
//   · `eval:student` (사이드카 필요)  → 합산이 후퇴하면 **스냅숏 기록을 거부**한다
//   · `coverageMargin.test.ts` (사이드카 불요) → **규칙 단독**이 스냅숏보다 낮으면 깨진다
//
// 규칙 단독은 결정적이라 언제 어디서든 같은 값이 나온다. 규칙을 좁히면 시험이 먼저
// 깨지고, 그걸 정당하게 통과시키려면 `eval:student`를 다시 돌려 **학생이 그 자리를
// 실제로 받았는지** 증명해야 한다.

/** 라쳇이 지키는 위반 유형 — 문장 3종 + 문서 4종 */
export const RATCHET_KINDS = [
  'literal',
  'paraphrase',
  'evasion',
  'direction_flip',
  'magnitude_gap',
  'horizon_gap',
  'flip_under_risk',
] as const;

export type RatchetKind = (typeof RATCHET_KINDS)[number];

export interface CoverageSnapshot {
  /** 잰 날 */
  measuredAt: string;
  /** **어느 가중치로 쟀는가.** 이름(model.onnx)은 늘 같으므로 이 값이 유일한 신원이다 */
  modelSha: string;
  threshold: number;
  byKind: Record<RatchetKind, { rules: number; student: number; combined: number }>;
  /**
   * **잣대가 바뀌어 라쳇을 끊었다면** 그 사실과 직전 스냅숏 (12차 M-3).
   *
   * 없으면 이 스냅숏은 앞 스냅숏에서 이어진 것이다. 있으면 그 지점에서 한 번 끊겼고,
   * 옛 숫자와 새 숫자는 **견줄 수 있는 값이 아니다** — 그 사실을 지우면 다음 사람이
   * 쭉 올라온 값으로 읽는다.
   */
  rebasedFrom?: CoverageSnapshot;
  rebaseReason?: string;
}

export const COVERAGE_SNAPSHOT_PATH = join(process.cwd(), 'training', 'coverage-snapshot.json');

export function readCoverageSnapshot(): CoverageSnapshot | null {
  if (!existsSync(COVERAGE_SNAPSHOT_PATH)) return null;
  return JSON.parse(readFileSync(COVERAGE_SNAPSHOT_PATH, 'utf-8')) as CoverageSnapshot;
}

/**
 * **규칙 단독 유형별 탐지율** — 사이드카 없이, 언제나 같은 값.
 *
 * 문장·문서 코퍼스를 함께 본다. 두 코퍼스의 유형은 겹치지 않으므로(문장 3종 / 문서 4종)
 * 한 사전에 합쳐도 충돌하지 않는다.
 */
export function ruleOnlyCoverage(): Partial<Record<RatchetKind, number>> {
  const detector = (i: Parameters<typeof applyRules>[0]) => applyRules(i);
  const stats = [
    ...evaluate(detector, SCREENING_CORPUS).byKind,
    ...evaluate(detector, COHERENCE_CORPUS).byKind,
  ];
  const out: Partial<Record<RatchetKind, number>> = {};
  for (const k of RATCHET_KINDS) {
    const s = stats.find((x) => x.kind === k);
    if (s) out[k] = s.rate;
  }
  return out;
}
