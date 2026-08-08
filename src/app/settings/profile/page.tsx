import { redirect } from "next/navigation";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import styles from "../../market.module.css";
import { ProfileForm } from "./ProfileForm";

export const dynamic = "force-dynamic";

// 프로필 설정 — 이용자·리서처 모두 쓴다.
// 단순 이용자에게는 공개 프로필 페이지가 없다(들어올 진입점이 없어 죽은 화면이 된다).
// 대신 필명은 팔로우·구매 맥락에서 표시되는 이름이라 본인이 고칠 수 있어야 한다.
// 리서처에게는 같은 필명이 공개 프로필·리포트·리더보드의 표시 이름이 된다.

export default async function ProfileSettingsPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login?next=/settings/profile");

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      penName: true,
      researcherProfile: { select: { id: true, bio: true } },
    },
  });
  if (!user) redirect("/login?next=/settings/profile");

  const researcherId = user.researcherProfile?.id ?? null;

  return (
    <>
      <AppHeader title="프로필 설정" backHref="/settings" />
      <main className={styles.page}>
        <p className={styles.sub}>
          {researcherId
            ? "필명은 공개 프로필·리포트·리더보드에 표시되는 이름입니다."
            : "필명은 리서처에게 보이는 표시 이름입니다. 정하지 않으면 익명으로 표시됩니다."}
        </p>
        <ProfileForm
          initialPenName={user.penName ?? ""}
          initialBio={user.researcherProfile?.bio ?? ""}
          researcherId={researcherId}
        />
      </main>
    </>
  );
}
