import Link from "next/link";
import { notFound } from "next/navigation";
import { NOTICE_AUDIENCES, noticeAudienceLabel, type NoticeAudience } from "@/domain/notice";
import { SUPPORT_TOPIC_SPECS, type SupportTopic } from "@/domain/supportTopics";
import { getAdminQueues } from "@/server/adminQueues";
import { prisma } from "@/server/db";
import { countNoticeRecipients, getRecentNotices } from "@/server/noticeService";
import { getSupportStats } from "@/server/supportService";
import { getSessionUserId } from "@/server/session";
import { AdminHead } from "../AdminHead";
import { NoticeForm } from "./NoticeForm";
import { SecHead } from "../Why";
import styles from "../admin.module.css";

export const dynamic = "force-dynamic";

// 소통 — **확성기 버튼이 여는 화면** (시안 v3 tk-ask / tk-say).
//
// 답변 로직(supportService.answerSupportTicket)은 있었는데 **화면이 없었고**,
// 공지는 보낼 길 자체가 없었다. 둘 다 여기서 끝난다.
//
// **탭 두 개로 가르는 이유**: 받은 문의는 사람이 나에게 온 말이고 공지는 내가 사람에게
// 갈 말이다 — 방향이 반대라 한 화면에 이어 붙이면 스크롤이 곧 방향 전환이 된다.
// 문의는 **오래 기다린 순**이다. 다른 큐는 건수를 세지만 문의는 **경과 시간**을 센다 —
// 답이 늦는 것 자체가 문제이기 때문이다.

/**
 * 문의 본문의 첫머리 — 줄에는 **그 사람이 무엇을 말했는지**가 실려야 한다.
 * 주제 이름만 있으면 같은 주제 다섯 건이 똑같은 줄 다섯 개로 보이고, 그러면
 * 무엇부터 열지를 목록이 못 정해 준다.
 */
function excerpt(detail: string, max = 28): string {
  const one = detail.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
}

/** 시안의 날짜 표기 — `8/17`. ko-KR 기본은 `8. 17.`이라 점과 공백이 줄을 늘린다 */
function slashDate(d: Date): string {
  const x = new Date(d);
  return `${x.getMonth() + 1}/${x.getDate()}`;
}

/** 접수부터 답변까지 — 이 숫자가 '평균 답변'의 재료다 */
function turnaround(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

function elapsed(from: Date, now: Date): { text: string; urgent: boolean } {
  const ms = now.getTime() - from.getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return { text: "방금", urgent: false };
  if (h < 24) return { text: `${h}시간`, urgent: h >= 12 };
  return { text: `${Math.floor(h / 24)}일`, urgent: true };
}

const DESK_LABEL: Record<string, string> = {
  security: "보안",
  money: "돈",
  report: "리포트",
  status: "상태",
};

/**
 * 문의를 **처리할 재료가 있는 화면**으로 보낸다 (시안 v3).
 *
 * "환불이 안 왔다"에 답하려면 그 사람의 환불 기록을 봐야 하는데 그건 돈 화면에만
 * 있다. 여기서 답까지 쓰게 하면 창구가 둘이 되고, 둘이 되는 순간 어느 쪽이 최신인지
 * 매번 되묻게 된다 — **이 탭은 세는 자리다.**
 */
const DESK_HREF: Record<string, string> = {
  money: "/admin/settlements?tab=ask",
  security: "/admin/frozen?tab=ask",
  status: "/admin/health?tab=ask",
  report: "/admin/compliance",
};

export default async function AdminInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (me?.role !== "OPERATOR") notFound();

  const tab = (await searchParams).tab === "say" ? "say" : "ask";
  const now = new Date();

  const [open, answered, q, notices, stats, ...counts] = await Promise.all([
    prisma.supportTicket.findMany({
      where: { status: "OPEN" },
      orderBy: { createdAt: "asc" }, // 오래 기다린 순 — 답이 늦는 것 자체가 문제다
      include: { user: { select: { penName: true, email: true } } },
    }),
    prisma.supportTicket.findMany({
      where: { status: { not: "OPEN" } },
      orderBy: { answeredAt: "desc" },
      take: 5,
      include: { user: { select: { penName: true, email: true } } },
    }),
    getAdminQueues(prisma, now),
    getRecentNotices(prisma),
    getSupportStats(prisma, now),
    ...NOTICE_AUDIENCES.map((a) => countNoticeRecipients(prisma, a)),
  ]);
  const noticeCounts = Object.fromEntries(
    NOTICE_AUDIENCES.map((a, i) => [a, counts[i]]),
  ) as Record<NoticeAudience, number>;

  // 탭에 접힌 것이 있으면 점을 찍는다 — 건수는 "얼마나", 점은 "오늘 안 끝나는 게 있나"
  const stalled = open.some((t) => elapsed(t.createdAt, now).urgent);

  return (
    <>
      <AdminHead title="소통" backHref="/admin" inbox={q.inbox} />
      <main className={styles.page}>
        <div className={styles.subtabs}>
          <Link
            href="/admin/inbox"
            className={`${styles.subtab} ${tab === "ask" ? styles.subtabOn : ""}`}
          >
            받은 문의 {open.length}
            {stalled && <span className={styles.tdot} />}
          </Link>
          <Link
            href="/admin/inbox?tab=say"
            className={`${styles.subtab} ${tab === "say" ? styles.subtabOn : ""}`}
          >
            내가 먼저 말하기
          </Link>
        </div>

        {tab === "ask" ? (
          <>
            {/* 이번 달 한 줄 — 다른 큐는 건수를 세지만 문의는 **시간**을 센다.
                답이 늦는 것 자체가 문제라, 평균 답변 시간이 접수 건수보다 중요하다 */}
            <div className={styles.card} style={{ padding: "12px 16px" }}>
              <div className={styles.pinRow}>
                <span>이번 달 문의</span>
                <span>
                  접수 {stats.received}건 · 평균 답변{" "}
                  <b style={{ color: "#0e8a71" }}>
                    {stats.avgAnswerMs === null
                      ? "—"
                      : stats.avgAnswerMs < 3_600_000
                        ? `${Math.max(1, Math.round(stats.avgAnswerMs / 60_000))}분`
                        : `${Math.round(stats.avgAnswerMs / 3_600_000)}시간`}
                  </b>
                </span>
              </div>
            </div>

            <SecHead title={<>답변 대기 <span className={styles.n}>{open.length}</span></>}>이용자가 <b>주제를 골라</b> 남긴 문의입니다. 자유 입력 창구를 두지 않는 이유는
                열어 두면 반드시 &ldquo;이 리포트 사도 될까요?&rdquo;가 들어오기 때문입니다 —
                답하면 1:1 투자자문이라 라이선스 영역입니다.</SecHead>

            {open.length === 0 ? (
              <div className={styles.empty}>
                <span className={styles.dot} />
                답변을 기다리는 문의가 없습니다
              </div>
            ) : (
              open.map((t) => {
                const spec = SUPPORT_TOPIC_SPECS[t.topic as SupportTopic];
                const el = elapsed(t.createdAt, now);
                return (
                  <Link
                    key={t.id}
                    href={DESK_HREF[t.desk] ?? "/admin"}
                    className={`${styles.lite} ${el.urgent ? styles.stripeNeg : styles.stripeWarn}`}
                  >
                    <span className={styles.liteMain}>
                      <span className={styles.liteName}>{spec?.label ?? t.topic}</span>
                      {/* **시각이 아니라 그 사람이 한 말**을 싣는다 (시안) — 얼마나 됐는지는
                          오른쪽 칩이 이미 말하고, 왼쪽에서 필요한 것은 "무엇에 대한 문의인가"다.
                          같은 주제라도 사연이 다르면 여는 순서가 달라진다 */}
                      <span className={styles.liteSub}>
                        {t.user.penName ?? t.user.email} · {excerpt(t.detail)}
                      </span>
                      <span className={styles.liteTags}>
                        <span className={styles.chip}>{DESK_LABEL[t.desk] ?? t.desk}</span>
                      </span>
                    </span>
                    <span className={styles.liteRight}>
                      <span className={`${styles.chip} ${el.urgent ? styles.chipNeg : styles.chipWarn}`}>
                        {el.text}
                      </span>
                      <span className={styles.go}>›</span>
                    </span>
                  </Link>
                );
              })
            )}

            {answered.length > 0 && (
              <>
                <div className={styles.sec}>
                  답변 완료 <small>최근 {answered.length}건</small>
                </div>
                {answered.map((t) => {
                  const spec = SUPPORT_TOPIC_SPECS[t.topic as SupportTopic];
                  return (
                    <div key={t.id} className={styles.lite}>
                      <span className={styles.liteMain}>
                        <span className={styles.liteName}>{spec?.label ?? t.topic}</span>
                        {/* **얼마나 걸렸는지**가 이 줄의 값어치다 (시안: `8/17 답변 · 3시간 만에`) —
                            답한 사실은 오른쪽 칩이 말하고, 여기서 배울 것은 내가 얼마나
                            빨리 답하는 사람인가다 */}
                        <span className={styles.liteSub}>
                          {t.answeredAt
                            ? `${slashDate(t.answeredAt)} 답변 · ${turnaround(t.createdAt, t.answeredAt)} 만에`
                            : "답변 시각 없음"}
                        </span>
                      </span>
                      <span className={styles.liteRight}>
                        <span className={`${styles.chip} ${styles.chipMint}`}>완료</span>
                      </span>
                    </div>
                  );
                })}
              </>
            )}

            {/* 이 화면에서 가장 쓸모 있는 한 줄 — **답을 잘 쓰는 것보다 문의가 올
                이유를 없애는 쪽이 효과가 크다.** 한 주제가 계속 올라오는데 이미
                안내가 있다면, 그건 답변의 문제가 아니라 안내가 안 읽히는 자리다 */}
            {stats.topTopic && stats.topCount >= 2 && (
              <div className={styles.auto}>
                <span className={styles.chip}>주제별 집계</span>
                <span>
                  <b>
                    {SUPPORT_TOPIC_SPECS[stats.topTopic]?.label ?? stats.topTopic} 문의가 이번
                    달 {stats.topCount}건으로 가장 많습니다.
                  </b>{" "}
                  {stats.topHasSelfServe ? (
                    <>
                      문의 화면이 이 주제의 답을 <b>폼보다 먼저</b> 보여주는데도 계속 온다면,{" "}
                      <b>안내가 안 읽히는 자리</b>라는 뜻입니다 — 답을 잘 쓰는 것보다 그 문구를
                      고치는 쪽이 문의를 줄입니다.
                    </>
                  ) : (
                    <>
                      이 주제에는 아직 <b>먼저 보여주는 답이 없습니다</b> — 한 줄 안내를 붙이면
                      다음 달 접수가 줄어듭니다 (domain/supportTopics.ts의 selfServe).
                    </>
                  )}
                </span>
              </div>
            )}
          </>
        ) : (
          <>
            <NoticeForm counts={noticeCounts} />

            <div className={styles.sec}>보낸 공지</div>
            {notices.length === 0 ? (
              <div className={styles.empty}>
                <span className={styles.dot} />
                아직 보낸 공지가 없습니다
              </div>
            ) : (
              notices.map((n) => (
                <div key={n.id} className={styles.lite}>
                  <span className={styles.liteMain}>
                    <span className={styles.liteName}>{n.title}</span>
                    <span className={styles.liteSub}>
                      {new Date(n.sentAt).toLocaleDateString("ko-KR")} 발송 ·{" "}
                      {/* 지금 다시 세면 그 사이 가입·탈퇴로 달라진다 — 보낸 순간의 수다 */}
                      {n.recipients.toLocaleString()}명 ·{" "}
                      {noticeAudienceLabel(n.audience)}
                    </span>
                  </span>
                  <span className={styles.liteRight}>
                    <span className={styles.go}>›</span>
                  </span>
                </div>
              ))
            )}
          </>
        )}
      </main>
    </>
  );
}
