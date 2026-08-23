"use client";

// 앱 내 이동 깊이 추적 — "뒤로 갈 곳이 앱 안에 있는가"를 답한다.
//
// window.history.length는 못 쓴다: 외부 사이트에서 들어와도 1보다 커서
// 뒤로가기가 앱 밖으로 튕긴다. 대신 앱 실행(모듈 평가 1회) 이후의 소프트
// 내비게이션만 센다 — floatingDismiss와 같은 "모듈 평가 = 실행 1회" 원리.
//
// popstate(브라우저 뒤로/앞으로)는 -2로 상쇄한다: pop 직후 pathname 효과가
// +1을 다시 더하므로 순증감이 -1이 된다. (앞으로 가기도 -1로 세는 단순화는
// 감수한다 — 깊이가 실제보다 작게 잡히면 폴백 경로로 가는 안전한 방향으로 틀린다)

let depth = 0;

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    depth = Math.max(0, depth - 2);
  });
}

/** NavTracker가 pathname 변화마다 부른다 (첫 화면 포함) */
export function bumpNavDepth(): void {
  depth += 1;
}

/** 앱 안에서 한 번이라도 이동했는가 — true면 history.back이 앱 안에 착지한다 */
export function canGoBackInApp(): boolean {
  return depth > 1;
}
