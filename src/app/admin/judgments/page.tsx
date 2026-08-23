import { redirect } from "next/navigation";

// 수동 판정 큐는 **리포트 화면의 '종목·시세' 탭으로 옮겼다** (2026-08-19, 시안 v3 rp-inst).
//
// 옮긴 이유: "시세를 못 구했다"와 "종목이 위험하다"는 둘 다 숫자를 봐야 끝나는 일인데
// 화면이 갈려 있어, 리포트를 보다 판정하러 옮기면 방금 보던 맥락이 사라졌다.
//
// **화면을 지우지 않고 넘긴다.** 이 주소는 알림 본문(opsAlertFeed)·되돌리기 안내문·
// 설정 메뉴에 이미 박혀 있고, 그중에는 **이미 발송된 알림**도 있다 — 지우면 그 알림을
// 누른 사람이 404를 만난다. 링크를 전부 고치는 것과 별개로 이 문은 열어 둔다.
export default function LegacyJudgmentsPage() {
  redirect("/admin/compliance?tab=inst");
}
