import { SUPPORT_TOPIC_SPECS, type SupportTopic } from "@/domain/supportTopics";
import { prisma } from "@/server/db";
import { AnswerForm } from "./inbox/AnswerForm";
import a from "./admin.module.css";

// 화면마다 붙는 **문의 탭** (시안 v3 — mn-ask / sc-ask / st-ask).
//
// **답은 그 문의를 처리할 재료가 있는 화면에서 쓴다.** 소통 화면은 세는 자리다 —
// 거기서 답까지 쓰게 하면 창구가 둘이 되고, 둘이 되는 순간 어느 쪽이 최신인지
// 매번 되묻게 된다. 그리고 "환불이 안 왔다"는 문의에 답하려면 그 사람의 환불
// 기록을 봐야 하는데, 그건 돈 화면에만 있다.
//
// 세 화면이 같은 컴포넌트를 쓰는 이유: 문의를 다루는 방식은 화면마다 다르지 않다.
// 다른 것은 **어떤 문의가 오느냐**뿐이고 그건 접수 시점에 박힌 desk가 정한다.

export function ticketElapsed(from: Date, now: Date): { text: string; urgent: boolean } {
  const h = Math.floor((now.getTime() - from.getTime()) / 3_600_000);
  if (h < 1) return { text: "방금", urgent: false };
  if (h < 24) return { text: `${h}시간`, urgent: h >= 12 };
  return { text: `${Math.floor(h / 24)}일`, urgent: true };
}

export function getDeskTickets(desk: string) {
  return prisma.supportTicket.findMany({
    where: { desk, status: "OPEN" },
    orderBy: { createdAt: "asc" }, // 오래 기다린 순 — 답이 늦는 것 자체가 문제다
    include: { user: { select: { penName: true, email: true } } },
  });
}

type Row = Awaited<ReturnType<typeof getDeskTickets>>[number];

export function DeskTickets({
  tickets,
  now,
  emptyLabel,
}: {
  tickets: Row[];
  now: Date;
  emptyLabel: string;
}) {
  if (tickets.length === 0) {
    return (
      <div className={a.empty}>
        <span className={a.dot} />
        {emptyLabel}
      </div>
    );
  }

  return (
    <>
      {tickets.map((t) => {
        const spec = SUPPORT_TOPIC_SPECS[t.topic as SupportTopic];
        const el = ticketElapsed(t.createdAt, now);
        return (
          <div key={t.id} className={`${a.card} ${el.urgent ? a.stripeNeg : a.stripeWarn}`}>
            <div className={a.row}>
              <span className={a.ttl}>{spec?.label ?? t.topic}</span>
              <span className={a.voice}>◍ 앱 문의 · {el.text}</span>
            </div>
            <div className={a.meta}>
              <span>{t.user.penName ?? t.user.email}</span>
              <span>{new Date(t.createdAt).toLocaleString("ko-KR")}</span>
            </div>
            <div className={a.quote}>{t.detail}</div>
            <AnswerForm ticketId={t.id} />
          </div>
        );
      })}
    </>
  );
}
