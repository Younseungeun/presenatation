"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { canGoBackInApp } from "./navHistory";

// 문맥을 아는 뒤로가기 — 앱 안에서 들어왔으면 진짜 이전 화면으로(history.back:
// 스크롤·필터·검색어가 그대로 복원된다), 알림·딥링크로 바로 진입했으면 fallback
// 경로로 간다.
//
// 기존 규칙(무조건 명시 경로)은 "리더보드 → 장바구니 → 뒤로 → MY"처럼 들어온 곳과
// 나가는 곳이 어긋나는 문제를 만들었다. fallback은 "논리적 부모"(딥링크의 착지점)로
// 남고, 실제로 온 길이 있으면 그 길로 되돌아간다.

export function SmartBackLink({
  fallback,
  className,
  "aria-label": ariaLabel,
  children,
}: {
  /** 앱 밖에서 바로 진입했을 때 갈 논리적 부모 경로 */
  fallback: string;
  className?: string;
  "aria-label"?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <Link
      href={fallback}
      className={className}
      aria-label={ariaLabel}
      onClick={(e) => {
        if (canGoBackInApp()) {
          e.preventDefault();
          router.back();
        }
      }}
    >
      {children}
    </Link>
  );
}
