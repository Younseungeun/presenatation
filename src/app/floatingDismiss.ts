"use client";

// 하단에 떠 있는 것들의 "닫음" 기억.
//
// 검증 중 팝업과 글쓰기 버튼이 **서로의 닫힘을 알아야** 한다 — 홈에서 검증 팝업을 닫으면
// 그 자리를 글쓰기 버튼이 물려받기 때문이다. 각자 sessionStorage를 읽으면 한쪽이 닫혀도
// 다른 쪽이 다시 그려질 계기가 없어(리렌더가 일어나지 않아) 자리가 빈 채로 남는다.
// 그래서 구독 가능한 저장소 하나로 모으고 useSyncExternalStore로 읽는다.
//
// 유지 범위는 **이번 실행 동안**이다. 앱을 다시 열거나 다시 로그인하면 되살아난다 —
// 둘 다 "지금 알아야 할 것"이라 영구히 감추면 안 되는 정보다.

export type FloatingKind = "judgment" | "compose";

const KEYS: Record<FloatingKind, string> = {
  judgment: "rm.judgmentPopup.dismissed.v1",
  compose: "rm.composeButton.dismissed.v1",
};

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

function safeRemove(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* 인앱 브라우저·시크릿 모드에서는 접근 자체가 막힌다 — 그때는 늘 보이는 쪽이 안전하다 */
  }
}

// 모듈은 전체 페이지 로드마다 한 번 평가된다 = 앱 실행 1회.
// 그래서 여기서 지우면 "실행할 때마다 다시 알린다"가 된다 (소프트 내비게이션에서는 유지).
if (typeof window !== "undefined") {
  safeRemove(KEYS.judgment);
  safeRemove(KEYS.compose);
}

export function subscribeFloatingDismiss(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function isFloatingDismissed(kind: FloatingKind): boolean {
  try {
    return sessionStorage.getItem(KEYS[kind]) !== null;
  } catch {
    return false;
  }
}

export function dismissFloating(kind: FloatingKind): void {
  try {
    sessionStorage.setItem(KEYS[kind], "1");
  } catch {
    /* 저장이 막힌 환경 — 이번 렌더에서만 닫힌다 */
  }
  notify();
}

/** 로그인·로그아웃 시 — 다음 사람에게는 처음부터 알린다 */
export function clearFloatingDismissals(): void {
  safeRemove(KEYS.judgment);
  safeRemove(KEYS.compose);
  notify();
}

/** 서버 렌더에서는 아무것도 닫혀 있지 않다 (하이드레이션 기준값) */
export function serverDismissSnapshot(): boolean {
  return false;
}
