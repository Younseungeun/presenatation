import Link from "next/link";
import styles from "./reportAbuse.module.css";

// 리포트 화면의 신고 진입점 — **이 버튼이 신고에 `reportId`를 붙이는 유일한 경로다.**
//
// 그전까지 신고는 홈 배너 → /clean 한 곳뿐이었고, 대상은 자유 입력 텍스트였다.
// 그래서 같은 리포트를 셋이 신고해도 시스템은 그것이 한 건인 줄 몰랐고, 그러면
// "이미 신고된 리포트입니다"도 "여럿이 신고하면 판매 중단"도 딛고 설 데가 없다.
//
// 자리는 **본문 맨 끝**이다. 신고는 리포트를 다 읽은 뒤에 하는 일이라 위에 두면
// 읽기 전에 판단을 재촉하는 꼴이 되고, 무엇보다 이 화면의 주인공이 아니다 —
// 작게, 그러나 찾으면 반드시 거기 있게.

export function ReportAbuseLink({ reportId }: { reportId: string }) {
  return (
    <div className={styles.wrap}>
      <Link href={`/clean?report=${encodeURIComponent(reportId)}`} className={styles.link}>
        <span aria-hidden="true">⚑</span>
        이 리포트 신고하기
      </Link>
      <p className={styles.note}>
        1:1 상담 유도, 수익 보장·투자 권유, 외부 리딩방 유인 등 규정 위반이 의심되면
        알려 주세요. 확인된 신고에는 보상을 드립니다.
      </p>
    </div>
  );
}
