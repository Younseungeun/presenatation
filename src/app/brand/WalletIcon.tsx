// 인투빌 카드지갑 (브랜드 자산, 좌표 원본 그대로 — 수정 금지).
// 원본: brand/intovill/ · 스킬 assets/icons/wallet{,-1,-2}.svg
//
// 상태는 min(담은 수, 2) — 2장이 그림 표시 상한. 0·1·2장은 그림이 스스로 구별하므로
// **배지 숫자는 그림이 셀 수 없는 3장부터만** 붙인다 (쓰는 쪽 규칙, 2026-08-09 확정)
// — 그림과 배지가 같은 수를 두 번 말하면 신호가 아니라 반복이다.
// 전부 currentColor라 색은 쓰는 쪽 텍스트색을 따른다.
// 크기 하한 20px — 그 아래에서는 엄지 노치가 안티에일리어싱으로 닫힌다.
// 1장 상태의 카드-포켓 틈(0.4)은 1배율 32px 미만에서 붙어 보일 수 있으나 원본 규정대로 둔다
// (모바일 2~3x에서는 24px로도 살아난다).

/** 지갑 테두리 + 포켓 — 세 상태가 바이트 단위로 공유하는 기하 */
function WalletShell() {
  return (
    <>
      <rect
        x="2.6"
        y="5.3"
        width="18.8"
        height="13.4"
        rx="2.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
      />
      <path
        d="M3.5 9.9 H9.65 L11.4 12.3 Q12 12.75 12.6 12.3 L14.35 9.9 H20.5
           V16.3 A1.5 1.5 0 0 1 19 17.8 H5 A1.5 1.5 0 0 1 3.5 16.3 Z"
        fill="currentColor"
      />
    </>
  );
}

export function WalletIcon({ count, size = 24 }: { count: number; size?: number }) {
  const state = Math.min(Math.max(count, 0), 2);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {state === 2 && (
        <path
          d="M4.7 6.6 H19.3 A0.6 0.6 0 0 1 19.9 7.2 V7.85 H4.1 V7.2
             A0.6 0.6 0 0 1 4.7 6.6 Z"
          fill="currentColor"
          fillOpacity="0.45"
        />
      )}
      {state === 2 && (
        <path
          d="M4.7 8.25 H19.3 A0.6 0.6 0 0 1 19.9 8.85 V9.5
             H14.15 L12.28 12.06 Q12 12.19 11.72 12.06 L9.85 9.5
             H4.1 V8.85 A0.6 0.6 0 0 1 4.7 8.25 Z"
          fill="currentColor"
        />
      )}
      {state === 1 && (
        <path
          d="M4.9 7.9 H19.1 A0.8 0.8 0 0 1 19.9 8.7 A0.8 0.8 0 0 1 19.1 9.5
             H14.15 L12.28 12.06 Q12 12.19 11.72 12.06 L9.85 9.5
             H4.9 A0.8 0.8 0 0 1 4.1 8.7 A0.8 0.8 0 0 1 4.9 7.9 Z"
          fill="currentColor"
        />
      )}
      <WalletShell />
    </svg>
  );
}
