import Link from "next/link";
import { notFound } from "next/navigation";
import { ASSET_CLASS_LABEL } from "@/domain/constants";
import { getAdminQueues } from "@/server/adminQueues";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getStatusScreen } from "@/server/statusScreen";
import { AdminHead } from "../AdminHead";
import { DeskTickets, getDeskTickets, ticketElapsed } from "../DeskTickets";
import { SecHead } from "../Why";
import a from "../admin.module.css";

export const dynamic = "force-dynamic";

// 상태 — **기계가 살아 있는가**를 묻는 화면 (시안 v3 scr-status).
//
// 여섯 묶음의 순서가 곧 우선순위다:
//   지금 경보    무엇이 아픈가 — 오늘 손대야 하는 것
//   스케줄러     **자기 자리를 갖는다.** 판정·마감·정산이 전부 이 프로세스 하나를 지난다
//   계기판       판정이 도는가 · 달력이 남아 있는가
//   운영 건강    인프라가 초록이어도 서비스는 죽을 수 있다 — 사업 로직 쪽
//   설정         지금 어떤 값으로 도는가 (읽는 자리, 바꾸는 곳은 따로)
//   휴면·CLI     지금은 안 도는 것들 — 없는 척하지 않는다

export default async function AdminStatusPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const tab = (await searchParams).tab === "ask" ? "ask" : "main";
  const now = new Date();
  const [s, tickets, q] = await Promise.all([
    getStatusScreen(prisma, now),
    getDeskTickets("status"),
    getAdminQueues(prisma, now),
  ]);
  const stalled = tickets.some((t) => ticketElapsed(t.createdAt, now).urgent);

  const beatText = s.scheduler.stuck
    ? `갇힘 — ${s.scheduler.running ?? "알 수 없음"}`
    : s.scheduler.ageMs === null
      ? "기록 없음"
      : s.scheduler.ageMs < 60_000
        ? `${Math.round(s.scheduler.ageMs / 1000)}초 전`
        : `${Math.floor(s.scheduler.ageMs / 60_000)}분 전`;

  return (
    <>
      <AdminHead title="상태" inbox={q.inbox} />
      <main className={a.page}>
        <div className={a.subtabs}>
          <Link href="/admin/health" className={`${a.subtab} ${tab === "main" ? a.subtabOn : ""}`}>
            상태 {s.alerts.length}
            {s.alerts.some((x) => x.level === "P0") && <span className={a.tdot} />}
          </Link>
          <Link
            href="/admin/health?tab=ask"
            className={`${a.subtab} ${tab === "ask" ? a.subtabOn : ""}`}
          >
            문의 {tickets.length}
            {stalled && <span className={a.tdot} />}
          </Link>
        </div>

        {tab === "ask" ? (
          <>
            <SecHead title={<>기타 문의{" "}
                <span className={`${a.n} ${tickets.length === 0 ? a.nCalm : ""}`}>
                  {tickets.length}
                </span></>}>주제가 정해지지 않은 문의입니다 — 앱이 느리다·화면이 이상하다 같은 것들이라{" "}
                <b>기계 상태와 함께 봐야</b> 답할 수 있습니다. 특정 종목·리포트에 대한 투자
                판단은 법에 따라 답변드릴 수 없습니다.</SecHead>
            <DeskTickets tickets={tickets} now={now} emptyLabel="답변을 기다리는 문의가 없습니다" />
          </>
        ) : (
          <>
            {/* ── ① 지금 경보 ─────────────────────────────────── */}
            <div className={a.sec}>
              지금 경보 <small>{s.alerts.length}건</small>
            </div>
            {s.alerts.length === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                켜진 경보가 없습니다 — 지표 {s.metrics.length}개 전부 정상
              </div>
            ) : (
              s.alerts.map((al, i) => (
                <div
                  key={i}
                  className={`${a.card} ${al.level === "P0" ? a.stripeNeg : a.stripeWarn}`}
                >
                  <div className={a.row}>
                    <span className={a.ttl}>{al.title}</span>
                    <span className={`${a.chip} ${al.level === "P0" ? a.chipNeg : a.chipWarn}`}>
                      {al.level}
                    </span>
                  </div>
                  <div className={a.meta}>
                    <span>{al.detail}</span>
                  </div>
                  {al.href && (
                    <Link href={al.href} className={a.xref} style={{ marginTop: 10 }}>
                      <span>
                        쌓인 카드 보러 가기 <small>— 해제도 거기서</small>
                      </span>
                      <span className={a.go}>›</span>
                    </Link>
                  )}
                </div>
              ))
            )}

            {/* ── ② 스케줄러 — 자기 자리를 갖는다 ────────────── */}
            <div className={a.sec}>
              스케줄러 <small>판정·마감·정산이 전부 여기를 지납니다</small>
            </div>
            <div
              className={`${a.card} ${
                !s.scheduler.alive || s.scheduler.stuck ? a.stripeNeg : ""
              }`}
            >
              <div className={a.kv}>
                <span className={a.kvK}>
                  심장박동 <small>살아 있나</small>
                </span>
                <span className={`${a.chip} ${s.scheduler.alive ? a.chipMint : a.chipNeg}`}>
                  {s.scheduler.alive ? beatText : "없음"}
                </span>
              </div>
              <div className={a.kv}>
                <span className={a.kvK}>
                  지금 도는 일 <small>일이 되고 있나</small>
                </span>
                <span className={`${a.chip} ${s.scheduler.stuck ? a.chipNeg : ""}`}>
                  {s.scheduler.running
                    ? `${s.scheduler.running}${
                        s.scheduler.runningForMs
                          ? ` · ${Math.floor(s.scheduler.runningForMs / 60_000)}분째`
                          : ""
                      }`
                    : "없음 — 대기 중"}
                </span>
              </div>
              <div className={a.kv}>
                <span className={a.kvK}>밀린 일</span>
                <span className={`${a.chip} ${s.scheduler.lag > 0 ? a.chipWarn : ""}`}>
                  {s.scheduler.lag > 0 ? `사람 앞에 ${s.scheduler.lag}장` : "없음"}
                </span>
              </div>

              {/* 멈춤은 두 얼굴이고 처방이 다르다 — 합쳐서 말하면 안 된다 */}
              {!s.scheduler.alive ? (
                <div className={`${a.note} ${a.noteNeg}`}>
                  심장이 안 뜁니다 — <b>프로세스가 죽었습니다.</b> 앱은 다른 프로세스를 띄울 수
                  없으니 호스팅 콘솔에서 <code>npm run scheduler</code>를 다시 올려야 합니다.
                </div>
              ) : s.scheduler.stuck ? (
                <div className={`${a.note} ${a.noteNeg}`}>
                  심장은 뛰는데 <b>한 항목에 갇혀 있습니다</b> — 프로세스는 살아 있고 일이 안
                  되는 상태입니다. 로그에서 그 항목을 먼저 보세요.
                </div>
              ) : (
                <div className={a.note}>정상입니다 — 이 화면에서 할 일은 없습니다.</div>
              )}
            </div>

            {/* 앱이 못 하는 일은 **문으로만** 둔다 — 버튼을 그려 놓고 아무 일도
                안 일어나는 것이 가장 나쁘다 */}
            <div className={a.xref}>
              <span>
                프로세스 재시작 <small>— 호스팅 콘솔</small>
              </span>
            </div>
            <div className={a.xref}>
              <span>
                바깥 감시 <small>— 서버가 통째로 죽으면 이 화면도 안 열립니다</small>
              </span>
            </div>

            {/* ── ③ 계기판 ────────────────────────────────────── */}
            <div className={a.sec}>계기판</div>
            <div className={a.card}>
              {s.dashboard.allClasses.map((c) => {
                const paused = s.dashboard.pausedClasses.includes(c);
                return (
                  <div key={c} className={a.kv}>
                    <span className={a.kvK}>{ASSET_CLASS_LABEL[c]} 판정</span>
                    <span className={`${a.chip} ${paused ? a.chipNeg : a.chipMint}`}>
                      {paused ? "정지" : "정상"}
                    </span>
                  </div>
                );
              })}
              <div className={a.kv}>
                <span className={a.kvK}>빗썸 교차검증 (코인)</span>
                <span
                  className={`${a.chip} ${
                    s.dashboard.crossCheckMode === "enforce" ? a.chipMint : a.chipWarn
                  }`}
                >
                  {s.dashboard.crossCheckMode === "off"
                    ? "꺼짐"
                    : s.dashboard.crossCheckMode === "shadow"
                      ? "기록만 — 판정을 막지 않음"
                      : "집행 중"}
                </span>
              </div>
              <div className={a.kv}>
                <span className={a.kvK}>
                  거래일 달력
                </span>
                <span className={a.chip}>{s.dashboard.calendarTo}까지</span>
              </div>
            </div>

            {/* ── ④ 운영 건강 ─────────────────────────────────── */}
            <div className={a.sec}>
              운영 건강 <small>인프라가 초록이어도 서비스는 죽을 수 있다</small>
            </div>
            <div className={a.card}>
              {s.metrics.map((m) => (
                <div key={m.key} className={a.kv} title={m.meaning}>
                  <span className={a.kvK}>
                    {m.label} <small>{m.sample}</small>
                  </span>
                  <span className={`${a.chip} ${m.alert ? a.chipWarn : a.chipMint}`}>{m.value}</span>
                </div>
              ))}
            </div>
            <p className={a.hint}>
              문턱은 전부 <strong>초안</strong>입니다 — 운영 데이터가 쌓이면 다시 잡습니다.
              표본이 작은 구간에서는 비율보다 분모를 먼저 보세요.
            </p>

            {/* ── ⑤ 설정 — 읽는 자리 ──────────────────────────── */}
            <div className={a.sec}>
              설정
            </div>
            <div className={a.card}>
              <div className={a.kv}>
                <span className={a.kvK}>시장 규모 띠지</span>
                <span className={`${a.chip} ${s.settings.marketTicker ? a.chipMint : ""}`}>
                  {s.settings.marketTicker
                    ? `켜짐${s.settings.marketTickerAmounts ? " · 금액 포함" : ""}`
                    : "꺼짐 (기본)"}
                </span>
              </div>
              <div className={a.kv}>
                <span className={a.kvK}>
                  교차검증 모드
                </span>
                <span
                  className={`${a.chip} ${
                    s.settings.crossCheckMode === "enforce" ? a.chipMint : ""
                  }`}
                >
                  {s.settings.crossCheckMode}
                </span>
              </div>
              <div className={a.kv}>
                <span className={a.kvK}>알림 채널</span>
                <span className={`${a.chip} ${s.settings.telegram ? a.chipMint : a.chipWarn}`}>
                  {s.settings.telegram ? "텔레그램 연결됨" : "연결 안 됨 — 경보가 앱 밖으로 안 나갑니다"}
                </span>
              </div>
              <div className={a.kv}>
                <span className={a.kvK}>일일 출금 한도</span>
                <span className={a.chip}>
                  {s.settings.dailyLimitKrw.toLocaleString()}원 · 배포로만 변경
                </span>
              </div>
            </div>

            {/* ── ⑥ 휴면·CLI 전용 — 없는 척하지 않는다 ──────── */}
            <div className={a.sec}>휴면·CLI 전용</div>
            <div className={a.card} style={{ opacity: 0.62 }}>
              <div className={a.kv}>
                <span className={a.kvK}>2인 승인 대기열 · 승인 건강도</span>
                <span className={a.chip}>
                  {s.solo ? "휴면 — 1인 모드" : "동작 중"}
                </span>
              </div>
              <div className={a.kv}>
                <span className={a.kvK}>판정 되돌리기 · 운영자 부여</span>
                <span className={a.chip}>CLI 전용</span>
              </div>
              <p className={a.hint}>
                파괴적이거나 권한을 만드는 일은 <b>화면에 두지 않습니다</b> — 탈취된 세션이
                콘솔에서 할 수 있으면 그 장치는 없는 것과 같습니다.
              </p>
            </div>
          </>
        )}
      </main>
    </>
  );
}
