import { redirect } from "next/navigation";
import { SUPPORT_DAILY_LIMIT, SUPPORT_TOPIC_SPECS, type SupportTopic } from "@/domain/supportTopics";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getMySupportTickets } from "@/server/supportService";
import { AppHeader } from "../AppHeader";
import styles from "../market.module.css";
import { SupportFlow } from "./SupportFlow";
import support from "./support.module.css";

export const dynamic = "force-dynamic";

// 문의 창구 (2026-08-18 사용자 확정 — 주제를 먼저 고르는 방식).
//
// **자유 입력 채팅을 만들지 않는다.** 열어 두면 "이 리포트 사도 될까요?"가 반드시
// 들어오는데, 답하면 1:1 투자자문이라 라이선스 영역이고(CLAUDE.md §1) 안 답하면
// 창구가 죽는다. 주제 목록과 그 근거는 domain/supportTopics.ts에 있다.

export default async function SupportPage() {
  const userId = await getSessionUserId();
  if (!userId) redirect("/login");

  const mine = await getMySupportTickets(prisma, userId);

  return (
    <>
      <AppHeader title="문의하기" backHref="/my" />
      <main className={styles.page} style={{ maxWidth: 720 }}>
        <p className={styles.sub}>
          어떤 일로 오셨는지 골라 주세요. 주제마다 자주 묻는 내용을 먼저 안내해 드리고,
          그래도 남는 문의만 접수합니다 — 대부분 안내에서 해결됩니다.
        </p>

        <SupportFlow />

        {mine.length > 0 && (
          <section style={{ marginTop: 32 }}>
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>내 문의</h2>
            <div className={support.mine}>
              {mine.map((t) => (
                <div key={t.id} className={support.mineRow}>
                  <div className={support.mineTop}>
                    <span>{SUPPORT_TOPIC_SPECS[t.topic as SupportTopic]?.label ?? t.topic}</span>
                    <span className={t.status === "OPEN" ? support.pillOpen : support.pillDone}>
                      {t.status === "OPEN" ? "답변 대기" : "답변 완료"}
                    </span>
                  </div>
                  <div className={support.mineWhen}>
                    {new Date(t.createdAt).toLocaleString("ko-KR")}
                  </div>
                  <div className={support.mineDetail}>{t.detail}</div>
                  {t.answer && <div className={support.mineAnswer}>{t.answer}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        <p className={styles.sub} style={{ marginTop: 24, fontSize: 12 }}>
          문의는 하루 {SUPPORT_DAILY_LIMIT}건까지 접수할 수 있습니다. 특정 종목이나 리포트에 대한
          투자 판단은 법에 따라 답변드릴 수 없습니다.
        </p>
      </main>
    </>
  );
}
