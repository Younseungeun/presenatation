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
              <Row href="/admin/judgments" label="판정 보류 큐" sub="수동 판정 대기 카드" />
              <Row href="/admin/settlements" label="정산 지시서" sub="환불·지급 실행 기록" />
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
