// **본문에 적힌 연락처** — 16차 T-3.
//
// ── 왜 정규식 하나로 안 되는가 ──────────────────────────────────────
// 15차에 휴대전화 정규식을 넣으면서 `rawOnly`(정규화 사본에는 안 돌림)를 붙였다.
// 공백을 걷어내면 없던 자릿수가 생기기 때문이다: `018260 2026년`(티커 + 연도) →
// `0182602026` → 휴대전화와 구별되지 않는다.
//
// 그 대가로 **띄어 쓴 번호와 전각 숫자를 놓쳤다**: `0 1 0 - 8 9 2 3 - 7 8 9 0`,
// `０１０-８９２３-７８９０`.
//
// ── 잰 것 ───────────────────────────────────────────────────────────
// 숫자 티커 3,554종 × 연도 60 × 단위 어미 10 = **213만 건**을 통과시켰다.
//
//   공백 제거 후 정규식만    오탐 66,600건 (3.12%)
//   단위 어미 가드 추가      오탐 13,320건 (0.62%)   ← 16차 T-3 제안
//   **묶음 모양 판별**       오탐 **0건** (0.000%)
//
// ── 왜 모양인가 ─────────────────────────────────────────────────────
// **사람이 전화번호를 적는 방식은 정해져 있다.** 3-4-4, 3-3-4, 붙여 쓴 11자리,
// 또는 글자마다 띄운 것. 티커+연도는 6-4라 그 목록에 없다.
//
// 이건 표가 아니라 **형식**이다 — 새 통신사가 생겨도 사람이 번호를 적는 모양은
// 안 바뀐다. 늘어나는 것은 앞자리(`01X`)뿐이고 그건 규제가 정한 닫힌 집합이다.

const SEPARATORS = /[\s.\-–—_·]+/;
/** 숫자로 시작해 숫자로 끝나는 최대 구간 (사이에 구분기호 허용) */
const DIGIT_RUN = /(?<!\d)\d[\d\s.\-–—_·]*\d(?!\d)/g;

// ── 동형자 (16차) ────────────────────────────────────────────────────
//
// `O1O_3321_4455` — 숫자 `0` 자리에 대문자 `O`를 썼다. 한글이 없어 문자 혼용 신호에도,
// 대문자라 소문자 판별식에도, 숫자가 아니라 전화번호 모양에도 안 걸린다.
//
// ── 왜 여기서는 표를 써도 되는가 ────────────────────────────────────
// "동형자 표는 항상 한 수 뒤"라고 적었고 그건 **낱말**에 대해서는 맞다 —
// `카ka5톡`의 `5`는 `S`가 아니라 `O`라, 무엇으로 바뀌었는지는 문맥이 정한다.
//
// 숫자는 다르다. **숫자 자리에 들어온 글자는 숫자를 흉내 낸 것 외에 다른 뜻이 없다.**
// 그래서 표를 쓰되 **숫자가 대부분인 덩어리 안에서만** 쓴다. 그 문맥 밖에서는
// 손대지 않으므로 `KOSPI200`·`HBM3E`·`SDI`는 그대로 남는다.
const HOMOGLYPH: Record<string, string> = { o: '0', l: '1', i: '1', s: '5', b: '8', z: '2', g: '9' };
/** @근거 시뮬 — 덩어리의 영숫자 중 숫자 비율. 아래로 내리면 `KOSPI200`(37%)이 들어온다 */
const DIGIT_DOMINANT = 0.6;

/** 숫자가 대부분인 덩어리 안에서만 동형자를 숫자로 되돌린다 */
function undoHomoglyphs(token: string): string {
  const alnum = token.replace(/[^a-zA-Z0-9]/g, '');
  if (alnum.length < 8) return token;
  const digits = (alnum.match(/\d/g) ?? []).length;
  if (digits / alnum.length < DIGIT_DOMINANT) return token;
  return token.replace(/[a-zA-Z]/g, (c) => HOMOGLYPH[c.toLowerCase()] ?? c);
}

/**
 * @근거 시뮬 — scripts/probeContactNumber.ts 로 재현한다(213만 건, 오탐 0).
 *   사람이 실제로 쓰는 표기만 담았다. 여기 없는 모양(`6,4` 등)은 전화번호가 아니라
 *   다른 숫자 둘이 이웃한 것이다.
 */
const PHONE_SHAPES = new Set(['11', '10', '3,4,4', '3,3,4', '3,8', '3,7']);

/** 이동전화 앞자리 — 규제가 정한 닫힌 집합 */
const MOBILE_DIGITS = /^01[016789]\d{7,8}$/;

export interface ContactNumberHit {
  start: number;
  end: number;
  quote: string;
}

/**
 * 본문에서 **휴대전화 모양으로 적힌 숫자**를 찾는다.
 *
 * 전각 숫자는 NFKC 가 풀어 준다. 길이가 바뀌지 않는 변환이라 원문 위치가 그대로 산다
 * (`０`→`0` 은 1:1) — 그래서 지도를 따로 들고 다닐 필요가 없다.
 */
export function findContactNumbers(text: string): ContactNumberHit[] {
  const normalized = text.normalize('NFKC');
  // NFKC 가 길이를 바꿨다면 위치를 믿을 수 없다. 그때는 인용문을 정규화본에서 뜬다
  const positionsHold = normalized.length === text.length;

  const hits: ContactNumberHit[] = [];

  // 동형자를 되돌린 사본에서도 한 번 본다 — 길이가 바뀌지 않는 1:1 치환이라
  // 위치가 그대로 산다. 원문에 손대지 않으므로 다른 층은 영향을 받지 않는다
  const scanned = new Set<string>();
  for (const raw of normalized.split(/\s+/)) {
    const undone = undoHomoglyphs(raw);
    if (undone === raw || scanned.has(undone)) continue;
    scanned.add(undone);
    const groups = undone.replace(/[^0-9\s.\-–—_·]/g, '').split(SEPARATORS).filter(Boolean);
    if (!MOBILE_DIGITS.test(groups.join(''))) continue;
    if (!PHONE_SHAPES.has(groups.map((g) => g.length).join(','))) continue;
    const at = text.indexOf(raw);
    hits.push({ start: Math.max(0, at), end: at >= 0 ? at + raw.length : text.length, quote: raw });
  }

  DIGIT_RUN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIGIT_RUN.exec(normalized)) !== null) {
    const groups = m[0].split(SEPARATORS).filter(Boolean);
    if (!MOBILE_DIGITS.test(groups.join(''))) continue;

    const shape = groups.map((g) => g.length).join(',');
    // 글자마다 띄운 것도 사람이 쓰는 모양이다 — 다만 **넷 이상** 쪼갰을 때만.
    // 셋 이하면 3-4-4 같은 정상 묶음과 구별되지 않아 목록으로 충분하다
    const spelledOut = groups.length > 3 && groups.every((g) => g.length === 1);
    if (!PHONE_SHAPES.has(shape) && !spelledOut) continue;

    const start = positionsHold ? m.index : 0;
    const end = positionsHold ? m.index + m[0].length : text.length;
    hits.push({ start, end, quote: positionsHold ? text.slice(start, end) : m[0] });
  }
  return hits;
}
