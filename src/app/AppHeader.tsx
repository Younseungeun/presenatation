import Link from "next/link";

// 화면별 상단 헤더 — 레이아웃이 아니라 각 페이지가 필요할 때만 직접 넣는다.
// 최상위 탭 화면(홈·리더보드·랭킹)에는 넣지 않는다. MY는 좌우 액션이 필요해 예외로 넣는다.
//
// 3열 그리드: [좌 44px][가운데 1fr][우 44px]
// - backHref를 주면 좌측이 뒤로가기 화살표가 된다(history.back 대신 명시적 경로 —
//   알림·딥링크로 바로 진입했을 때도 갈 곳이 있다). left를 직접 주면 그쪽이 우선한다.
// - center를 주면 제목 대신 임의 요소(예: 모드 전환 스위치)를 넣는다.
// - titleAs="span": 본문에 이미 h1이 있는 화면(리포트 상세 등)에서 h1 중복을 피한다.
export function AppHeader({
  title,
  center,
  backHref,
  left,
  right,
  titleAs = "h1",
  seamless = false,
}: {
  title?: string;
  center?: React.ReactNode;
  backHref?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  titleAs?: "h1" | "span";
  /** 구분선·반투명 배경을 없애 본문과 한 덩어리로 보이게 한다(MY 등) */
  seamless?: boolean;
}) {
  const TitleTag = titleAs;

  return (
    <header className={`appbar${seamless ? " appbarSeamless" : ""}`}>
      <div className="appbarInner">
        <div className="appbarSide">
          {left ??
            (backHref ? (
              <Link href={backHref} className="appbarIconBtn" aria-label="뒤로">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="M15 5l-7 7 7 7"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
            ) : null)}
        </div>

        {center ?? <TitleTag className="appbarTitle">{title}</TitleTag>}

        <div className="appbarSide appbarSideRight">{right}</div>
      </div>
    </header>
  );
}
