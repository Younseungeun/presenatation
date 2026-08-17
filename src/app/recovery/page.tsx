import { RecoveryForm } from "./RecoveryForm";

// 비상 복구 화면 (2026-08-17 검토 7차 Q1) — **로그인 밖에 있다.**
//
// /admin 아래에 두면 안 된다. 그쪽은 운영자 세션과 패스키 관문이 지키는 구역인데,
// 이 화면이 필요한 상황은 정확히 **그 둘 다 불가능한 상황**이다.
//
// ⚠ 디자인 보류 — 기능만 있는 최소 화면이다(docs/design-backlog.md).
//   평생 한 번 열릴까 말까 한 화면이라 우선순위가 가장 낮지만, 열리는 그날은
//   반드시 동작해야 한다.

export const metadata = { title: "비상 복구" };

export default function RecoveryPage() {
  return <RecoveryForm />;
}
