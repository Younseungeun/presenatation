import Link from "next/link";
import type { Metadata } from "next";
import { getAdminQueues } from "@/server/adminQueues";
import { prisma } from "@/server/db";
import { passkeyGateBypassed } from "@/server/devGates";
import { getSessionUserId } from "@/server/session";
import { AdminTabBar } from "./AdminTabBar";
import { OperatorPasskeyGate } from "./OperatorPasskeyGate";
import styles from "./admin.module.css";

// 관리 화면 전체를 감싸는 **부트스트랩 관문 + 5화면 껍데기**.
//
// ── 관문 (2026-08-17 검토 6차 Q1) ──────────────────────────────
// 패스키 0개인 관리자에게는 어느 /admin/* 화면 대신 **등록 관문**이 뜬다 —
// 개별 화면이 아니라 레이아웃에 두는 이유: 화면이 하나라도 빠지면 그 화면이
// 공백기의 뒷문이 된다. 서버 API는 requireOperatorId가 같은 조건으로 닫는다.
//
// ── 껍데기 (2026-08-19 시안 이식) ──────────────────────────────
// 하단 5탭이 여기 사는 이유: **화면마다 붙이면 화면마다 낡는다.** 탭 배지 숫자도
// 여기서 한 번만 세어 전 화면이 같은 값을 말하게 한다 (server/adminQueues.ts).
//
// ── 이용자 화면과의 경계 ────────────────────────────────────
// 이 껍데기는 이용자 껍데기((app)/layout.tsx) 위에 덧입혀지는 것이 **아니다.**
// 둘은 뿌리(app/layout.tsx = html·body뿐) 아래 나란히 선 형제다. 그래서 여기에는
// 판정 팝업도, 홈·리더보드 탭바도, 약관 푸터도 오지 않는다 — 운영자가 볼 화면이
// 아니기 때문이다. 관리 화면이 이용자 컴포넌트를 가져다 쓰는 일도 없다(딱 하나,
// 설정 화면의 시세 티커 미리보기는 _shared에서 가져온다 — 그건 "이용자에게 이렇게
// 보인다"를 보여 주는 것이 목적이라 실물과 같아야 한다).

export const metadata: Metadata = {
  title: "인투빌 운영",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const userId = await getSessionUserId();
  if (!userId) return <>{children}</>;

  const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  // 비운영자는 각 화면의 기존 가드(404/안내)가 처리하므로 여기서는 지나보낸다
  if (me?.role !== "OPERATOR") return <>{children}</>;

  const passkeys = await prisma.passkey.count({ where: { userId } });
  const bypassed = passkeyGateBypassed();
  if (passkeys === 0 && !bypassed) {
    return (
      <>
        {/* 관문의 머리도 관리 화면의 것을 쓴다 — 이용자 헤더를 빌려 오면 이 화면만
            글꼴도 여백도 다른 화면이 된다. 확성기는 달지 않는다: 아직 못 들어온
            사람에게 "소통으로 가기"를 열어 줄 이유가 없다 */}
        <div className={styles.apphead}>
          <div className={styles.headLeft}>
            <Link href="/" className={styles.back} aria-label="돌아가기">
              ‹
            </Link>
            <div>
              <h1>관리자 권한 활성화</h1>
            </div>
          </div>
        </div>
        <OperatorPasskeyGate />
      </>
    );
  }

  const queues = await getAdminQueues(prisma);

  return (
    <>
      {/* 우회 중이라는 사실이 화면에 없으면 관문이 살아 있다고 착각한 채 개발하게 되고,
          그 착각이 출시까지 따라간다 */}
      {passkeys === 0 && bypassed && (
        <div className={styles.devBanner}>
          ⚠ 개발 모드 — 패스키 관문을 건너뛴 상태입니다 (DEV_SKIP_PASSKEY_GATE). 운영
          배포에서는 이 값이 있으면 서버가 시작되지 않습니다.
        </div>
      )}
      <div className={styles.shell}>{children}</div>
      <AdminTabBar
        counts={{
          report: queues.report.total,
          money: queues.money.total,
          sec: queues.sec.total,
          status: queues.status.total,
        }}
        tones={{
          report: queues.report.tone,
          money: queues.money.tone,
          sec: queues.sec.tone,
          status: queues.status.tone,
        }}
      />
    </>
  );
}
