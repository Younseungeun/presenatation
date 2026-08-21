import a from "./admin.module.css";

/**
 * **이 클릭 하나가 검사기 둘을 고친다** (인계 2호 §3-② · 회신 2호 C-1).
 *
 * 운영자의 판정은 두 갈래로 갈라져 서로 다른 검사기를 먹인다:
 *
 *   빠른 길 — 사전 등록  →  몇 초 만에 규칙 엔진에 (정확히 그 표현만)
 *   느린 길 — 학습 라벨  →  다음 재학습 때 학생에게 (비슷한 말까지)
 *
 * 그런데 **둘 다 조용히 끊긴다.** 표현을 안 적으면 빠른 길이 없고, 유형을 안 고르면
 * 느린 길이 없는데, 지금까지 화면은 그 사실을 말하지 않았다 — 버튼은 똑같이 눌리고
 * 결과도 똑같아 보인다. 끊긴 것을 아는 유일한 방법이 몇 달 뒤 "학습 자료가 왜 이것뿐이지"였다.
 *
 * ── 반려와 철회의 무게가 다르다 (실측) ────────────────────────────
 * 유형을 안 골랐을 때:
 *   반려(정탐) → operatorTraining 이 "검수가 지적한 그대로 인정"으로 읽어 **살아남는다**
 *   철회(미탐) → `return null`. **통째로 버려진다**
 * 미탐이 가장 값진 라벨인데 정확히 거기서 끊기므로, 철회 쪽만 경고 색으로 그린다.
 *
 * **막지는 않는다** (회신 2호 C-1 (나)안): 강제하면 유형을 모르는 운영자가 아무거나
 * 찍고, 다중 라벨 학습에서 틀린 양성은 라벨이 없는 것보다 나쁘다(반대 방향을 가르친다).
 */
export function TwoPaths({
  takedown,
  phrase,
  categoryCount,
}: {
  takedown: boolean;
  phrase: string;
  categoryCount: number;
}) {
  const verb = takedown ? "철회" : "반려";
  // **유형이 없으면 표현도 등록되지 않는다** — `registerPhrase` 가 `cats?.[0]` 을 요구하고,
  // 없으면 등록을 통째로 거절한다. 표현만 보고 ✓ 를 그리던 첫 판은 거짓말이었다:
  // 유형을 안 고른 채 표현만 적으면 화면은 "빠른 길 열림"이라 말하는데 실제로는
  // 두 길이 다 끊긴다. 그리고 그 사실은 결과 알림에 한 줄 섞여 지나간다
  const fastOn = phrase.length > 0 && categoryCount > 0;
  const fastBlockedByCategory = phrase.length > 0 && categoryCount === 0;
  // 반려는 유형이 비어도 "소견 그대로 인정"으로 라벨이 남는다 — 철회만 비면 버려진다
  const slowOn = categoryCount > 0 || !takedown;
  const slowLost = takedown && categoryCount === 0;

  return (
    <div className={a.sent} style={{ marginTop: 8 }}>
      <div className={a.sTag}>{verb}하면 일어나는 일 — 검사기 두 곳</div>

      <div className={a.meta} style={{ marginTop: 2 }}>
        <span
          style={{
            color: fastBlockedByCategory ? "#b45309" : fastOn ? "var(--text)" : "var(--text-faint)",
            fontWeight: fastBlockedByCategory ? 600 : undefined,
          }}
        >
          {fastOn ? "✓" : "✕"} <b>빠른 길</b> · 규칙 엔진{" "}
          {fastOn ? (
            <>
              — 사전에 <b>&ldquo;{phrase}&rdquo;</b> 등록. 다음 리서처가 <b>글 쓰는 중에</b>{" "}
              바로 경고를 받습니다
            </>
          ) : fastBlockedByCategory ? (
            <>
              — <b>유형을 고르지 않아 이 표현은 등록되지 않습니다.</b> 표현은 고른 유형에
              붙어서만 사전에 올라갑니다
            </>
          ) : (
            <>— 등록할 표현이 없어 이 판정은 규칙에 아무것도 남기지 않습니다</>
          )}
        </span>
      </div>

      <div className={a.meta} style={{ marginTop: 2 }}>
        <span
          style={{
            color: slowLost ? "#b45309" : slowOn ? "var(--text)" : "var(--text-faint)",
            fontWeight: slowLost ? 600 : undefined,
          }}
        >
          {slowOn ? "✓" : "✕"} <b>느린 길</b> · 학생 모델{" "}
          {slowLost ? (
            <>
              — <b>유형을 고르지 않아 이 판정은 학습에 쓰이지 않습니다.</b> 놓친 유형을
              고르면 다음 재학습 때 학생이 비슷한 말까지 배웁니다
            </>
          ) : categoryCount > 0 ? (
            <>
              — 고른 유형 {categoryCount}개가 라벨이 되어, 다음 재학습 때 학생이{" "}
              <b>비슷한 말까지</b> 배웁니다
            </>
          ) : (
            <>— 유형을 안 고르면 &ldquo;검수가 짚은 그대로&rdquo;가 라벨이 됩니다</>
          )}
        </span>
      </div>
    </div>
  );
}
