// orderId는 paymentIntentService가 `pi_{reportId}_{난수}` 형태로 만든다.
// cuid는 영문 소문자·숫자만 쓰므로 밑줄로 안전하게 쪼갤 수 있다.
// 성공/실패 리다이렉트 화면이 추가 조회 없이 "어느 리포트로 돌아갈지" 알기 위한 용도다
// (신뢰 판단에는 쓰지 않는다 — 실제 승인 여부는 서버가 다시 확인한다).
export function reportIdFromOrderId(orderId: string | null): string | null {
  if (!orderId) return null;
  const parts = orderId.split("_");
  if (parts.length !== 3 || parts[0] !== "pi") return null;
  return parts[1];
}
