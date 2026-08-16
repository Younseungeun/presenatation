import Link from "next/link";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../AppHeader";
import styles from "../market.module.css";
import { LogoutButton } from "../my/LogoutButton";

export const dynamic = "force-dynamic";

// 설정 — MY 헤더 좌측 톱니바퀴의 목적지. 계정·앱 수준 설정만 모은다.
// (구매·판정 같은 활동 내역은 MY에 남긴다)

function Row({ href, label, sub, hardNav }: { href: string; label: string; sub?: string; hardNav?: boolean }) {
  const body = (
    <>
      <div className={styles.rowMain}>
        <div className={styles.rowName}>{label}</div>
        {sub && <div className={styles.rowSub}>{sub}</div>}
      </div>
      <span className={styles.rowArrow} aria-hidden="true">
        ›
      </span>
    </>
  );
  return hardNav ? (
    <a href={href} className={styles.row}>
      {body}
    </a>
  ) : (
    <Link href={href} className={styles.row}>
      {body}
    </Link>
  );
}

export default async function SettingsPage() {
  const userId = await getSessionUserId();
  const user = userId
    ? await prisma.user.findUnique({
        where: { id: userId },
        select: { penName: true, email: true, role: true },
      })
    : null;

  return (
    <>
      <AppHeader title="설정" backHref="/my" />
      <main className={styles.page}>
        {user && (
          <>
            <div className={styles.section}>계정</div>
            <div className={styles.list}>
              <div className={styles.row}>
                <div className={styles.rowMain}>
                  <div className={styles.rowName}>{user.penName ?? user.email}</div>
                  <div className={styles.rowSub}>휴대폰 본인 인증 완료 · 1인 1계정</div>
                </div>
              </div>
              <Row
                href="/settings/profile"
                label="프로필 설정"
                sub={user.penName ? `필명 ${user.penName}` : "필명이 아직 없습니다"}
              />
              <Row
                href="/settings/devices"
                label="로그인 기기"
                sub="지문·얼굴로 로그인 · 등록된 기기 관리"
              />
              {/* 급할 때 찾아야 하는 화면이라 계정 묶음 안, 프로필 바로 아래 둔다.
                  안내 문구에 "동결"을 그대로 적는 이유: 알림을 받고 이 목록을 훑는
                  사람이 찾는 단어가 그 단어다 */}
              <Row
                href="/settings/payout"
                label="정산 계좌 보호"
                sub="내가 바꾸지 않은 계좌 변경이라면 — 정산 동결"
              />
            </div>
          </>
        )}

        <div className={styles.section}>앱</div>
        <div className={styles.list}>
          {/* 앱 실행 화면(AppLaunch)은 루트 레이아웃에 있어 소프트 내비게이션으로는
              다시 마운트되지 않는다 → 전체 페이지 로드가 필요하다 */}
          <Row
            href="/?tour=1"
            label="앱 사용 안내 다시 보기"
            sub="예측 카드·자동 판정·환불 구조 4단계"
            hardNav
          />
        </div>

        <div className={styles.section}>약관·정책</div>
        <div className={styles.list}>
          <Row href="/terms/TERMS_OF_SERVICE" label="이용약관" />
          <Row href="/terms/PRIVACY_POLICY" label="개인정보처리방침" />
          <Row href="/terms/RESEARCHER_AGREEMENT" label="리서처 이용계약" />
        </div>

        {user?.role === "OPERATOR" && (
          <>
            <div className={styles.section}>운영</div>
            <div className={styles.list}>
              {/* 대시보드가 홈이다 — 큐마다 건수가 붙어 있어 들어가 볼 필요를 화면이 말해 준다 */}
              <Row href="/admin" label="운영 홈" sub="기다리는 일 전부, 건수와 함께" />
              {/* 맨 위 — 다른 운영자가 기다리고 있는 요청이라 가장 먼저 보여야 한다 */}
              <Row href="/admin/approvals" label="승인 대기열" sub="2인 승인 — 동결 해제·고액 지급·판정" />
              {/* 동결은 급한 사람의 신고다 — 승인 대기열 바로 아래, 다른 큐보다 앞 */}
              <Row href="/admin/frozen" label="정산 동결 관리" sub="동결된 계정 확인·해제 (2인 승인)" />
              <Row href="/admin/health" label="운영 건강" sub="매일 보는 사업 로직 숫자들" />
              <Row href="/admin/judgments" label="판정 보류 큐" sub="수동 판정 대기 카드" />
              {/* 접수가 정산을 잠그므로 푸는 화면이 정산 지시서보다 앞에 있어야 한다 */}
              <Row href="/admin/disputes" label="판정 이의" sub="구매자 이의 확정 (정산 잠금 해제)" />
              <Row href="/admin/settlements" label="정산 지시서" sub="환불·지급 실행 기록" />
              <Row href="/admin/abuse-reports" label="신고 검토" sub="클린 리서치 신고 확인·기각" />
              <Row href="/admin/settings" label="운영 설정" sub="시장 규모 띠지 표시 등" />
            </div>
          </>
        )}

        {user ? (
          <div style={{ marginTop: 24 }}>
            <LogoutButton />
          </div>
        ) : (
          <div className={styles.list} style={{ marginTop: 16 }}>
            <Row href="/login" label="로그인 / 시작하기" sub="휴대폰 본인 인증 (1인 1계정)" />
          </div>
        )}
      </main>
    </>
  );
}
