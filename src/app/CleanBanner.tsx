import Link from "next/link";
import { REWARD_QUOTA, rewardedCount } from "@/server/abuseReportService";
import { prisma } from "@/server/db";
import { ReportReviewIcon } from "./brand/ReportReview";
import styles from "./cleanBanner.module.css";

// 클린 리서치 신고 배너 — 출시 초기 자동 감시가 성숙하기 전 이용자 신고가 1차 탐지망.
// 흰 화면에서 유일한 다크(브랜드 Deep Ink) 요소라 시선이 가고, 장식 대신
// 살아있는 잔여 보상 수량(선착순)이 시선 포인트다.
//  ⚠ 문구에 "쿠폰"을 쓰지 않는다 (2026-08-18) — 쿠폰 발행·사용 기능이 아직 없다.
//    보상은 실제로 하되 수단은 확인 후 개별 안내다 (clean/page.tsx 주석 참고)
//  · 리더보드(카드를 사는 화면 = 위반을 목격하는 자리)에서는 강조형(emphasis)
//  · 홈에서는 맨 아래 잔잔한 기본형
export async function CleanBanner({ emphasis = false }: { emphasis?: boolean }) {
  const remaining = Math.max(0, REWARD_QUOTA - (await rewardedCount(prisma)));

  return (
    <Link
      href="/clean"
      className={`${styles.banner} ${emphasis ? styles.emphasis : ""}`}
    >
      {/* 리포트 검수 일러스트 — 소형 컷(48px 미만) 기본형.
          다크 배경 전용 컷도 있지만, 어두운 띠지 위에서 밝은 카드가 더 또렷해 기본형을 쓴다 */}
      <ReportReviewIcon size={emphasis ? 44 : 40} tone="light" className={styles.icon} />
      <span className={styles.copy}>
        {emphasis && <span className={styles.eyebrow}>클린 리서치</span>}
        <strong className={styles.title}>리포트 신고하고 보상 받기</strong>
        <span className={styles.sub}>1:1 상담·투자 권유는 신고 대상이에요</span>
      </span>
      <span className={styles.count}>
        <strong>{remaining.toLocaleString()}</strong>
        <span>장 남음</span>
      </span>
      <svg
        className={styles.chevron}
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M9 6l6 6-6 6"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </Link>
  );
}
