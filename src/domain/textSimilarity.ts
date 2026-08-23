// 글자 2-gram 자카드 유사도 (21차 Y-3) — 졸업 대비쌍의 복붙 감지 전용.
//
// **형태의 거리지 뜻의 거리가 아니다.** "안 됩니다"/"불가능합니다"는 여기서 멀지만
// 뜻은 같고, "원금보장"/"원금보전"은 여기서 가깝지만 뜻은 정반대다 (21차 검토가
// gap 17형 함정으로 명시). 그래서 이 값의 용도는 하나뿐이다 — 운영자가 같은 문장을
// 복붙하거나 낱말 한둘만 바꿔 "명목 3문장, 실질 1문장"을 만드는 것을 막는 것.
// 의미적 다양성은 여기로 잴 수 없고, 잴 수 있는 척하지 않는다.
//
// 낱말 토큰이 아니라 글자 2-gram 인 이유: 한국어는 교착어라 조사·어미가 낱말 경계를
// 흐려 낱말 자카드가 과소평가된다. 글자 2-gram 은 띄어쓰기 장난에도 둔감하다.

export function charBigrams(text: string): Set<string> {
  const s = text.replace(/\s+/g, '');
  const grams = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) grams.add(s.slice(i, i + 2));
  return grams;
}

export function charBigramJaccard(a: string, b: string): number {
  const ga = charBigrams(a);
  const gb = charBigrams(b);
  if (ga.size === 0 && gb.size === 0) return 1;
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}
