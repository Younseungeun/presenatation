import {
  applyRules,
  type Finding,
  type RegisteredPhrase,
  type ScreeningInput,
} from './compliance';

/**
 * **새 표현 하나로 게시 중 리포트를 다시 훑는다** (2026-08-25 창업자 확정).
 *
 * ── 왜 필요한가 ────────────────────────────────────────────────────
 * 학습 표현은 "이런 게 위반이더라"를 배운 결과인데, 지금은 그 지식이 **앞으로 올라올
 * 글에만** 닿는다. 이미 팔리는 글에는 영원히 안 닿고, 위험이 큰 쪽은 오히려 그쪽이다.
 *
 * ── 두 가지를 지킨다 ──────────────────────────────────────────────
 * ① **새 표현으로만 잰다.** 전체 기준으로 다시 훑으면 운영자가 이미 "괜찮다"고 넘긴
 *    건이 표현을 등록할 때마다 또 뜬다 — 그러면 목록이 곧 배경음이 된다. 새 표현이
 *    잡은 것만 남기면 **매번 새로운 정보**만 올라온다.
 * ② **처분하지 않는다.** 여기서 나오는 것은 목록뿐이고 게시는 그대로다. 강제 철회는
 *    전액 환불 + 정산 0 + 점수 0 이라, 손으로 넣은 문자열 하나가 그걸 자동으로
 *    일으키면 안 된다(사전 항목이 영원히 WARN 인 것과 같은 이유).
 *
 * ── 등록 **전에** 부르는 것이 핵심이다 ──────────────────────────────
 * 20건이 걸리면 그 표현은 너무 넓은 것이다. 지금은 그것을 등록하고 한참 뒤 집계로만
 * 알 수 있는데, 이 함수는 **등록을 누르기 전에** 답한다.
 */
export interface RescanTarget {
  reportId: string;
  input: ScreeningInput;
}

export interface RescanHit {
  reportId: string;
  /** 걸린 문장 — 원문 기준. 운영자가 자기 눈으로 판단할 유일한 재료다 */
  quote: string;
  category: Finding['category'];
}

/**
 * 표현 하나가 잡는 게시물을 고른다.
 *
 * `applyRules` 는 코드 규칙도 함께 돌리므로 **출처가 `learned` 인 소견만** 남긴다 —
 * 코드 규칙이 잡은 것은 이 표현의 공이 아니고, 그건 게시 시점에 이미 판정된 것이다.
 * 규칙 id 까지 대조하는 이유: 사전에 다른 항목이 함께 실려 들어와도 섞이지 않게.
 */
export function rescanForPhrase(
  targets: readonly RescanTarget[],
  phrase: RegisteredPhrase,
  knownNames?: ReadonlySet<string>,
): RescanHit[] {
  const mine = `learned:${phrase.id}`;
  const hits: RescanHit[] = [];
  for (const t of targets) {
    const findings = applyRules(t.input, { knownNames, phrases: [phrase] });
    for (const f of findings) {
      if (f.source !== 'learned' || f.ruleId !== mine) continue;
      hits.push({ reportId: t.reportId, quote: f.quote ?? '', category: f.category });
      break; // 한 리포트는 한 줄로 — 같은 표현이 두 번 걸려도 볼 것은 하나다
    }
  }
  return hits;
}
