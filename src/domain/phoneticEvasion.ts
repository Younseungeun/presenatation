// **음성 변형 회피** — `텔레그렘`·`원금보쟝`·`카카오툭` (16차, 15차 코퍼스 ③군).
//
// ── 이것을 규칙으로 못 한다고 적었던 것을 뒤집는다 ──────────────────
// 13차에 "③ 음성 변형은 규칙 불가, 학생 모델의 몫"이라고 적었다. 그 판단의 근거는
// "변형이 무한하다"였는데, **변형은 무한해도 원본으로부터의 거리는 유한하다.**
//
//   텔레그렘 → 텔레그램   자모 거리 1
//   카카오툭 → 카카오톡   자모 거리 1
//   원금보쟝 → 원금보장   자모 거리 1
//   손실보쟝 → 손실보전   자모 거리 2
//
// 표가 아니라 **거리**다. 새 변형(`텔레그럠`·`원끔보장`)이 나와도 표를 고칠 필요가 없다 —
// 13차 P-6이 노렸던 "구조적 방어"가 실제로 성립하는 자리가 여기다.
//
// ── 왜 자모 단위인가 ────────────────────────────────────────────────
// 음절 단위로 재면 `램`과 `렘`이 그냥 다른 글자라 거리 1이 아니라 1음절 전체다.
// 회피는 **음절 안의 모음 하나**를 바꾼다(ㅐ→ㅔ, ㅏ→ㅑ, ㅗ→ㅜ). 자모로 풀어야 그
// 한 글자가 보인다.
//
// ── 이 방어의 한계 ──────────────────────────────────────────────────
// 금지어 목록이 필요하다. 다만 그 목록은 **규제가 정한 개념**이라 닫혀 있다
// (텔레그램·카카오톡·원금보장…). 늘어나는 것은 그 개념을 부르는 **새 이름**이지
// 개념 자체가 아니다. 새 메신저가 나오면 여기 한 줄 는다.

import { insideInstrument, instrumentSpans } from './evasionNormalize';
import type { RiskCategory } from './compliance';

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';

/** 한글 음절을 초·중·종성으로 푼다. 한글이 아니면 그대로 둔다 */
export function toJamo(s: string): string[] {
  const out: string[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code >= 0 && code < 11172) {
      out.push(CHO[Math.floor(code / 588)], JUNG[Math.floor((code % 588) / 28)]);
      const jong = code % 28;
      if (jong > 0) out.push(JONG[jong]);
    } else {
      out.push(ch);
    }
  }
  return out;
}

function levenshtein(a: readonly string[], b: readonly string[], cap: number): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > cap) return cap + 1;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    // 이 행 전체가 이미 상한을 넘었으면 더 볼 것이 없다
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[n];
}

export interface PhoneticKeyword {
  word: string;
  category: RiskCategory;
  /** 사전 원천 키워드만: 어느 등록 표현에서 왔는가 (20차 — 표현별 정확도 추적) */
  phraseId?: string;
}

/**
 * 음성 변형을 감시할 금지어.
 *
 * **규제가 정한 개념의 이름들**이다. 원문 정규식이 이미 잡는 것과 같은 낱말이며,
 * 여기서는 그 낱말의 **주변**(자모 거리 안)을 함께 막는다.
 */
export const PHONETIC_KEYWORDS: PhoneticKeyword[] = [
  { word: '텔레그램', category: 'SOLICIT_CONTACT' },
  { word: '카카오톡', category: 'SOLICIT_CONTACT' },
  { word: '카톡', category: 'SOLICIT_CONTACT' },
  { word: '오픈채팅', category: 'SOLICIT_CONTACT' },
  { word: '리딩방', category: 'SOLICIT_CONTACT' },
  { word: '단톡방', category: 'SOLICIT_CONTACT' },
  { word: '개인상담', category: 'SOLICIT_CONTACT' },
  { word: '개인챗', category: 'SOLICIT_CONTACT' },
  { word: '원금보장', category: 'PROFIT_GUARANTEE' },
  { word: '손실보전', category: 'PROFIT_GUARANTEE' },
  { word: '수익보장', category: 'PROFIT_GUARANTEE' },
  { word: '확정수익', category: 'PROFIT_GUARANTEE' },
];

/**
 * @근거 시뮬 — scripts/probePhonetic.ts · scripts/probeEvasion.ts 로 재현한다.
 *
 *   처음에는 상한을 2로 뒀는데, 종목 마스터 16,553건과 금융 용어를 통과시키니
 *   **정상 낱말 둘이 거리 2로 걸렸다**: `원금보존`→`원금보장`, `수익보전`→`수익보장`.
 *   `원금보존추구형`은 실제 상품 유형이라 이 오탐은 치명적이다.
 *
 *   상한을 **1로 조였다.** 거리 2가 필요했던 유일한 변형은 `손실보쟝`인데, 그걸 잡으려고
 *   `손실보장`을 목록에 넣었더니 이번엔 **`손실보상`(정상 용어)이 거리 1로 걸렸다.**
 *   그 낱말은 애초에 금지 개념도 아니라(규제가 금하는 것은 `손실보전`) 도로 뺐다.
 *   `손실 0% 보쟝` 은 완곡 표현 규칙(`손실s*(율|률)?s*0s*%`)이 잡는다.
 *
 *   **거리를 늘리는 대신 층을 나눈다** — 근사 매칭을 느슨하게 하면 정상 한국어가
 *   무한히 들어오지만, 다른 층이 맡으면 그 자리만 막힌다.
 *
 *   실측(상한 1): 변형 11/11 탐지 · 종목 마스터 16,553건 충돌 **0건**(화이트리스트 적용)
 *   · 정상 금융 용어 12건 오탐 0건.
 */
const MAX_DISTANCE = 1;

export interface PhoneticHit {
  category: PhoneticKeyword['category'];
  keyword: string;
  /** 원문에서 걸린 구간 */
  start: number;
  end: number;
  quote: string;
  distance: number;
  /** 사전 원천이면 등록 표현 id */
  phraseId?: string;
}

/**
 * 본문에서 금지어와 **자모 거리가 가까운** 구간을 찾는다.
 *
 * 공백·기호를 걷어낸 사본 위에서 창을 민다 — `텔레 그렘`처럼 띄어 쓴 변형도 잡기 위함이다.
 * 원문 위치는 지도로 되짚어 인용문을 만든다.
 *
 * **정확히 같은 낱말(거리 0)은 내지 않는다** — 그건 원문 정규식이 이미 잡았고,
 * 여기서 또 내면 같은 위반이 두 번 보고된다.
 */
export function findPhoneticEvasion(
  text: string,
  known: ReadonlySet<string> = new Set(),
  // **사전 원천 키워드가 여기로 합류한다** (20차 X-1). 기본은 코드 목록 그대로 —
  // 사전 항목은 등록 시 충돌 검사를 통과한 것만 호출부가 실어 보낸다
  keywords: readonly PhoneticKeyword[] = PHONETIC_KEYWORDS,
): PhoneticHit[] {
  // 종목명은 처음부터 뺀다 — `카카오뱅크`가 `카카오톡` 근처로 오는 일을 막는다
  const spans = instrumentSpans(text, known);

  const chars: string[] = [];
  const origin: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (/[\s.,·․‧•*_~^|'"`()[\]{}\-–—/\\]/.test(text[i])) continue;
    chars.push(text[i]);
    origin.push(i);
  }
  const bare = chars.join('');
  if (bare.length === 0) return [];

  const hits: PhoneticHit[] = [];
  for (const { word, category, phraseId } of keywords) {
    // **낱말이 그대로 들어 있으면 이 층은 침묵한다.**
    //
    // 그 경우는 원문·정규화 층이 이미 보고 있고, 거기에는 우연을 걸러내는 장치가
    // 붙어 있다(간격 판별식·부정 문맥). 근사 매칭에는 그런 장치가 없다.
    //
    // 실제로 이것 때문에 `실적은 복원. 금보장 구역 개발도 호재입니다`가 걸렸다 —
    // 정규화하면 `…복원금보장구역…`이고, 거기서 창을 한 글자 넓힌 `원금보장구`가
    // `원금보장`과 자모 거리 **2**다(음절 하나 = 자모 둘~셋). 즉 **정확히 들어 있는
    // 낱말은 언제나 자기 자신의 근사 매칭을 만든다.** 근사는 근사일 때만 봐야 한다.
    if (bare.includes(word)) continue;

    const target = toJamo(word);
    const cap = MAX_DISTANCE;
    let best: PhoneticHit | null = null;

    // 창의 길이는 원본 음절 수 ±1 — 자모 하나가 늘거나 줄어야 한 음절이 달라진다
    for (let len = Math.max(1, word.length - 1); len <= word.length + 1; len += 1) {
      for (let i = 0; i + len <= bare.length; i += 1) {
        const windowJamo = toJamo(bare.slice(i, i + len));
        const d = levenshtein(windowJamo, target, cap);
        if (d === 0 || d > cap) continue;
        const start = origin[i];
        const end = (origin[i + len - 1] ?? start) + 1;
        if (insideInstrument(spans, start, end)) continue;
        if (!best || d < best.distance) {
          best = {
            category,
            keyword: word,
            start,
            end,
            quote: text.slice(start, end),
            distance: d,
            ...(phraseId ? { phraseId } : {}),
          };
        }
      }
    }
    if (best) hits.push(best);
  }
  return hits;
}

// ── 사전 등록 시 충돌 검사 (20차 X-1) ─────────────────────────────────

export interface PhoneticCollision {
  /** 무엇과 부딪혔나 — 정상 낱말 또는 정상 문장의 걸린 조각 */
  against: string;
  kind: 'term' | 'corpus';
}

/**
 * 이 표현을 음성 변형 층(5층)에 태워도 되는가 — **등록 시점에 한 번** 잰다.
 *
 * 근사 매칭은 등록 표현의 자모 거리-1 이웃까지 삼킨다. 그 이웃이 정상 낱말이면
 * (`수익보장` 등록 → `수익보전` 이 거리 1 — 실제 상품 유형) 그 낱말을 쓴 성실한
 * 리포트가 전부 보류된다. λ=4 에서 그 대가가 미탐보다 크므로, 충돌하는 표현은
 * 5층에서 빼고 1~3층만 태운다.
 *
 * **운영과 같은 매처(`findPhoneticEvasion`)로 잰다** — 검사용 논리를 따로 쓰면
 * 검사는 통과했는데 운영에서 부딪히는 두 번째 답이 생긴다 (13차 배선 누락과 같은 모양).
 *
 * ⚠ 한계 (20차 반증 조건 1): 이 검사는 **지금 아는** 정상 낱말·문장과만 대조한다.
 * 내일 상장하는 종목명·새 금융 상품명은 못 지킨다 — 그쪽은 종목 마스터 동기화 직후
 * 도는 `checkWhitelistCollisions` 가 (신규 이름 ↔ 기존 사전) 방향으로 다시 잰다.
 */
export function phoneticCollisions(
  word: string,
  normalTerms: Iterable<string>,
  normalSentences: Iterable<string>,
): PhoneticCollision[] {
  const out: PhoneticCollision[] = [];
  const probe: PhoneticKeyword[] = [{ word, category: 'PROFIT_GUARANTEE' }];

  // ① 정상 낱말과 직접 대조 — 낱말 자체가 이웃이면 문장 검사를 볼 것도 없다
  for (const term of normalTerms) {
    // 표현이 용어를 포함하거나 그 반대면 근사가 아니라 포함 관계 — 매처가 침묵하므로 안전
    if (term === word || term.includes(word) || word.includes(term)) continue;
    if (findPhoneticEvasion(term, new Set(), probe).length > 0) {
      out.push({ against: term, kind: 'term' });
    }
  }

  // ② 정상 문장 스캔 — 낱말 목록에 없는 표기(합성어·활용형)가 여기서 걸린다
  for (const sentence of normalSentences) {
    const hits = findPhoneticEvasion(sentence, new Set(), probe);
    for (const h of hits) out.push({ against: h.quote, kind: 'corpus' });
  }

  // 같은 상대는 한 번만
  const seen = new Set<string>();
  return out.filter((c) => {
    if (seen.has(c.against)) return false;
    seen.add(c.against);
    return true;
  });
}

/**
 * 근사 매칭이 부딪히기 쉬운 **정상 금융 낱말** — 등록 충돌 검사의 상비 후보.
 *
 * 상한을 2에서 1로 조일 때 실측으로 드러난 이웃들이다(위 @근거 주석). 상한 1에서는
 * 대부분 안 걸리지만, 여기 두는 이유는 **사전 등록이 이 낱말들의 거리-1 안으로
 * 들어오는 것**을 막기 위해서다 — `원금보존` 곁에 등록하면 실제 상품 유형이 걸린다.
 */
export const PHONETIC_SAFE_TERMS: readonly string[] = [
  '원금보존',
  '원금보존추구형',
  '수익보전',
  '손실보상',
  '수익배분',
];
