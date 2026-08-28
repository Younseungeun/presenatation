import { redirect } from "next/navigation";

// 검출 항목 관리는 재학습 논의 자료 상세로 합쳐졌다 (2026-08-28 창업자 지시) —
// 근거 데이터가 같으므로 한 화면에서 사건별(질문지)과 규칙별(사다리)을 함께 본다.
// 옛 링크·북마크는 이 리다이렉트로 새 자리로 보낸다.
export default function DetectionLadderRedirect() {
  redirect("/admin/compliance/teacher");
}
