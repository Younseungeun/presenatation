import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../AppHeader";
import { OperatorPasskeyGate } from "./OperatorPasskeyGate";

// 관리 화면 전체를 감싸는 부트스트랩 관문 (2026-08-17 검토 6차 Q1).
//
// 패스키 0개인 관리자에게는 어느 /admin/* 화면 대신 **등록 관문**이 뜬다 —
// 개별 화면이 아니라 레이아웃에 두는 이유: 화면이 하나라도 빠지면 그 화면이
// 공백기의 뒷문이 된다. 서버 API는 requireOperatorId가 같은 조건으로 닫는다.
// 비운영자는 각 화면의 기존 가드(404/안내)가 처리하므로 여기서는 지나보낸다.

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (userId) {
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (me?.role === "OPERATOR") {
      const passkeys = await prisma.passkey.count({ where: { userId } });
      if (passkeys === 0) {
        return (
          <>
            <AppHeader title="관리자 권한 활성화" backHref="/" />
            <OperatorPasskeyGate />
          </>
        );
      }
    }
  }
  return <>{children}</>;
}
