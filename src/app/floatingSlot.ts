// 하단 떠 있는 요소는 한 번에 하나만 — 검증 중 팝업과 글쓰기 버튼이 겹치면
// 둘 다 읽히지 않고 탭바까지 가린다. 어느 쪽을 띄울지는 **화면이 무엇을 하러 온 곳인가**로 정한다.
//
//   · 홈      → 검증 중 팝업. 홈은 "내 것이 어떻게 되고 있나"를 보러 오는 자리다
//   · 리더보드·랭킹 → 글쓰기. 남의 카드와 순위를 보다가 "나도 낸다"로 이어지는 자리다
//   · MY      → 글쓰기. 검증 팝업은 원래 MY에서 뜨지 않는다(목적지가 MY라서)
//   · 그 밖(리포트 상세 등) → 검증 팝업만. 글쓰기는 탭 화면에서만 띄운다 —
//     하위 화면은 하던 일이 있는 자리라 새 일을 권하지 않는다
//
// 규칙을 이 한곳에 두는 이유: 두 컴포넌트가 각자 판단하면 언젠가 둘 다 뜨거나 둘 다 사라진다.

export type FloatingSlot = 'judgment' | 'compose' | null;

export interface FloatingInput {
  /** 검증 중인 구매가 있고 아직 닫지 않았는가 */
  hasJudgment: boolean;
  /** 리서처 계정인가 — 글쓰기 버튼은 리서처에게만 있다 */
  canCompose: boolean;
}

/** 글쓰기 버튼을 띄우는 탭 화면 */
function isComposeScreen(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/leaderboard' ||
    pathname === '/ranking' ||
    pathname === '/my' ||
    pathname.startsWith('/my/')
  );
}

export function floatingSlotFor(pathname: string, input: FloatingInput): FloatingSlot {
  const compose = input.canCompose && isComposeScreen(pathname);

  // MY는 검증 팝업이 뜨지 않는 화면이라 글쓰기만 남는다
  if (pathname === '/my' || pathname.startsWith('/my/')) {
    return compose ? 'compose' : null;
  }

  // 홈은 검증 팝업이 먼저 — 내 것이 어떻게 되고 있는지가 우선이다
  if (pathname === '/') {
    if (input.hasJudgment) return 'judgment';
    return compose ? 'compose' : null;
  }

  // 리더보드·랭킹은 글쓰기가 먼저 — 남의 것을 보다가 내 것을 내는 자리다
  if (pathname === '/leaderboard' || pathname === '/ranking') {
    if (compose) return 'compose';
    return input.hasJudgment ? 'judgment' : null;
  }

  // 하위 화면은 하던 일이 있는 자리라 새 일을 권하지 않는다
  return input.hasJudgment ? 'judgment' : null;
}
