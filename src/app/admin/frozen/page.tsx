import Link from "next/link";
import { getAdminQueues } from "@/server/adminQueues";
import { prisma } from "@/server/db";
import { getSecurityScreen } from "@/server/securityScreen";
import { getSessionUserId } from "@/server/session";
import { AdminHead } from "../AdminHead";
import { DeskTickets, getDeskTickets, ticketElapsed } from "../DeskTickets";
import { MismatchActions } from "./MismatchActions";
import { fmtDayMonth as fmtDate } from "@/lib/format";
import { SecHead } from "../Why";
import a from "../admin.module.css";
import sec from "./security.module.css";

export const dynamic = "force-dynamic";

// 보안 — **네 묶음은 "내가 할 일이 있는가"로 갈린다** (시안 v3 scr-sec).
//
//   동결 목록      본인이 스스로 잠갔다 → 이대로 두는 것이 정상. 연락이 와야 시작한다
//   계좌 명의 확인 이름이 안 맞는다 → **여기만 손대는 자리다**
//   계좌 변경 유예 낯선 기기에서 바꿨다 → 48시간이 흐르는 중, 내가 할 일은 없다
//   보안 신호      낯선 로그인·기기 변경 → **없는 것이 정상**
//
// 셋은 읽는 자리고 하나만 손대는 자리다. 그 차이가 화면에 있어야 열 때마다
// "무엇을 해야 하지"를 다시 묻지 않는다.

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const userId = await getSessionUserId();
  const me = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    : null;
  if (me?.role !== "OPERATOR") {
    return (
      <>
        <AdminHead title="보안" />
        <main className={a.page}>
          <div className={a.empty}>운영자만 볼 수 있는 화면입니다.</div>
        </main>
      </>
    );
  }

  const tab = (await searchParams).tab === "ask" ? "ask" : "main";
  const now = new Date();
  const [s, tickets, q] = await Promise.all([
    getSecurityScreen(prisma, now),
    getDeskTickets("security"),
    getAdminQueues(prisma, now),
  ]);
  const stalled = tickets.some((t) => ticketElapsed(t.createdAt, now).urgent);
  // 손대야 하는 것만 센다 — 동결·유예는 두는 것이 정상이라 "할 일"이 아니다
  const todo = s.mismatches.length + q.sec.approvals;

  return (
    <>
      <AdminHead title="보안" inbox={q.inbox} />
      <main className={a.page}>
        <div className={a.subtabs}>
          <Link href="/admin/frozen" className={`${a.subtab} ${tab === "main" ? a.subtabOn : ""}`}>
            보안 {todo}
            {s.mismatches.length > 0 && <span className={a.tdot} />}
          </Link>
          <Link
            href="/admin/frozen?tab=ask"
            className={`${a.subtab} ${tab === "ask" ? a.subtabOn : ""}`}
          >
            문의 {tickets.length}
            {stalled && <span className={a.tdot} />}
          </Link>
        </div>

        {tab === "main" ? (
          <>
            {/* ── 동결 중 — 두는 것이 정상이라 숫자가 조용하다 ── */}
            <SecHead title={<>동결 중 <span className={`${a.n} ${a.nCalm}`}>{s.frozen.length}</span></>}>본인이 <b>스스로 잠근</b> 상태입니다 — 이대로 두는 것이 정상이고 지금 할 일은
                없습니다. 해제는 <b>본인에게서 연락이 왔을 때만</b> 시작합니다. 계정을 쥔
                탈취자의 요청과 진짜 본인의 요청은 화면에서 구별되지 않으니, 유선 통화 등
                앱 밖 경로로 확인하세요.</SecHead>

            <div className={a.sec}>동결 목록</div>
            {s.frozen.length === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                동결된 계정이 없습니다
              </div>
            ) : (
              s.frozen.map((f) => (
                <Link
                  key={f.researcherUserId}
                  href={`/admin/frozen/${f.researcherUserId}`}
                  className={a.lite}
                >
                  <span className={a.liteMain}>
                    <span className={a.liteName}>{f.displayName}</span>
                    <span className={a.liteSub}>
                      {fmtDate(new Date(f.frozenAt))} 동결 ·{" "}
                      {f.heldKrw > 0 ? `${f.heldKrw.toLocaleString()}원 묶임` : "묶인 정산 없음"}
                    </span>
                  </span>
                  <span className={a.liteRight}>
                    <span className={a.chip}>{f.days === 0 ? "오늘" : `${f.days}일째`}</span>
                    <span className={a.go}>›</span>
                  </span>
                </Link>
              ))
            )}

            {/* ── 계좌 명의 확인 — 이 화면에서 유일하게 손대는 자리 ── */}
            <div className={a.sec}>계좌 명의 확인</div>
            {s.mismatches.length === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                이름이 어긋난 계좌가 없습니다
              </div>
            ) : (
              s.mismatches.map((m) => (
                <div key={m.researcherUserId} className={`${a.card} ${a.stripeWarn}`}>
                  <div className={a.row}>
                    <span className={a.ttl}>
                      {m.displayName} ({m.account})
                    </span>
                    <span className={`${a.chip} ${a.chipWarn}`}>명의 불일치</span>
                  </div>
                  {/* 두 이름이 **같은 높이에 나란히** 서야 눈이 바로 비교한다 */}
                  <div className={sec.duel}>
                    <div className={sec.src}>
                      <div className={sec.srcName}>본인 인증 실명</div>
                      <div className={sec.srcValue}>{m.verifiedName}</div>
                    </div>
                    <div className={sec.src}>
                      <div className={sec.srcName}>은행 예금주</div>
                      <div className={sec.srcValue}>{m.bankHolder}</div>
                    </div>
                  </div>
                  <div className={a.note}>
                    사고일 수도, 오탈자일 수도 있습니다. <b>확인 전까지 이 계좌로는 한 푼도
                    안 나갑니다.</b>
                  </div>
                  <MismatchActions researcherUserId={m.researcherUserId} />
                </div>
              ))
            )}

            {/* ── 계좌 변경 유예 — 흐르는 중, 내가 할 일은 없다 ── */}
            <div className={a.sec}>
              계좌 변경 유예 <small>낯선 기기에서 바꾼 건</small>
            </div>
            {s.cooldowns.length === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                유예 중인 계좌 변경이 없습니다
              </div>
            ) : (
              s.cooldowns.map((c) => (
                <div key={c.researcherUserId} className={a.card}>
                  <div className={a.row}>
                    <span className={a.ttl}>{c.displayName} — 유예 중</span>
                    <span className={a.chip}>
                      {c.hoursLeft > 0 ? `${c.hoursLeft}시간 남음` : "곧 해제"}
                    </span>
                  </div>
                  <div className={a.meta}>
                    <span>계좌 {c.account}</span>
                    <span>{new Date(c.until).toLocaleString("ko-KR")} 해제</span>
                    <span>본인이 평소 기기에서 번호를 넣으면 즉시 풀림</span>
                  </div>
                  <div className={a.note}>
                    우리가 할 일은 없습니다 — 본인 확인 문의가 오면 이 화면을 보고 답하세요.
                  </div>
                </div>
              ))
            )}

            {/* ── 보안 신호 — 없는 것이 정상 ── */}
            <div className={a.sec}>
              보안 신호 <small>없는 것이 정상</small>
            </div>
            {s.signals.length === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                낯선 경로 로그인 · 기기 변경 · 종이 열쇠 — 최근 {s.signalWindowDays}일 0건
              </div>
            ) : (
              <div className={`${a.card} ${a.feed}`}>
                {s.signals.map((n) => (
                  <div key={n.id} className={a.feedRow}>
                    <span className={`${a.dot} ${a.dotWarn}`} />
                    <span className={a.feedBody}>
                      <span className={a.feedTitle}>{n.title}</span>
                      <span className={a.feedMeta}>
                        {new Date(n.createdAt).toLocaleString("ko-KR")}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* 시안의 보안 화면은 여기서 끝난다 — 승인 대기열은 1인 모드에서 휴면이라
                상태 화면의 '휴면·CLI 전용'이 이미 말하고 있다 */}
            <div className={a.xref}>
              <span>
                고위험 작업 감사{' '}
                <small>— 지급·환불·수동판정·되돌리기·권한변경</small>
              </span>
              <span className={a.go}>›</span>
            </div>
          </>
        ) : (
          <>
            <SecHead title={<>해제 요청{" "}
                <span className={`${a.n} ${tickets.length === 0 ? a.nCalm : ""}`}>
                  {tickets.length}
                </span></>}>본인이 <b>앱에서 직접</b> 남긴 요청입니다. 다만 <b>이 글이 본인 증명은
                아닙니다</b> — 계정을 쥔 사람도 로그인해서 똑같이 씁니다. 여전히{" "}
                <b>어느 경로로 확인했는가</b>가 판단의 재료이고,{" "}
                <b>해제는 동결 상세에서 따로</b> 합니다. 여기서는 연락하겠다는 답만 보냅니다 —
                두 일을 한 버튼에 묶으면 글을 읽은 것이 곧 확인한 것이 됩니다.</SecHead>
            <DeskTickets
              tickets={tickets}
              now={now}
              emptyLabel="답변을 기다리는 보안 문의가 없습니다"
            />
          </>
        )}
      </main>
    </>
  );
}
