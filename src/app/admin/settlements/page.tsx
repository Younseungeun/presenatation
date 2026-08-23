import Link from "next/link";
import { notFound } from "next/navigation";
import { DUAL_APPROVAL_THRESHOLD_KRW } from "@/domain/operatorApproval";
import { prisma } from "@/server/db";
import {
  MONEY_TABS,
  MONEY_TAB_LABEL,
  getMoneyScreen,
  isMoneyTab,
  type MoneyTab,
} from "@/server/moneyScreen";
import { getSessionUserId } from "@/server/session";
import { SETTLEMENT_COOLDOWN_HOURS } from "@/server/settlementCooldown";
import { AdminHead } from "../AdminHead";
import { DeskTickets } from "../DeskTickets";
import { fmtDayMonth as fmtDate } from "@/lib/format";
import { ExecuteButton } from "./ExecuteButton";
import { RefundGroupButton } from "./RefundGroupButton";
import { CompensationExecute, CompensationReview } from "./CompensationActions";
import { SecHead } from "../Why";
import a from "../admin.module.css";

export const dynamic = "force-dynamic";

/**
 * 구매자 이름은 가린다 — 첫 글자만 남기고 `김**` (시안).
 *
 * 리서처는 필명이 이미 앱 전체에 공개돼 있어 그대로 적지만, 구매자 이름은 **여기에만**
 * 있다. 실행 화면이 답해야 하는 질문은 "이 돈이 누구 것인가"가 아니라 "이 건이 맞는가"라,
 * 사람을 특정할 수 있을 만큼 적을 이유가 없다. 문의·이의로 사람을 찾아야 할 때는
 * 그 화면이 따로 있다.
 */
function maskPerson(name: string): string {
  const head = name.split("@")[0].trim();
  if (!head) return "***";
  return `${[...head][0]}**`;
}

// 돈 — **탭 다섯은 돈이 움직이는 방향으로 갈린다** (시안 v3 scr-money).
//
// 전에는 환불·지급·보상이 한 화면에 세로로 이어져 있었다. 그러면 오늘 할 일이
// 스크롤 길이가 되고, 성격이 다른 실행(남의 돈을 옮기는 것 / 회사 돈이 줄어드는 것 /
// 판매를 없던 일로 만드는 것)이 같은 속도로 지나간다.
//
// **한도는 탭 밖, 화면 맨 끝에 둔다.** 이 화면에 오는 이유는 실행이지 조회가 아니라
// 열자마자 할 일이 먼저 보여야 한다. 접혀서 안 보이는 위험은 카드 안에서 이미 막았다 —
// 한도에 걸린 지급 카드가 자기 자리에서 "오늘 남은 한도"를 말한다.

export default async function AdminSettlementsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const raw = (await searchParams).tab;
  const tab: MoneyTab = isMoneyTab(raw) ? raw : "refund";
  const now = new Date();
  const m = await getMoneyScreen(prisma, now);

  // 보상 두 목록의 리서처 표시명 — 지시서에는 userId만 있다
  const compUserIds = [
    ...new Set([
      ...m.compReviews.map((g) => g.researcherUserId),
      ...m.compExecutable.map((c) => c.researcherUserId),
    ]),
  ];
  const compNames = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: compUserIds } },
        select: { id: true, penName: true, email: true },
      })
    ).map((u) => [u.id, u.penName ?? u.email]),
  );

  // 시안의 지급 묶음 설명은 "몇 건이 오늘 막혀 있는지"까지 말한다 — 탭을 열기 전에
  // 이미 알아야 오늘 할 일의 크기가 잡힌다
  const blockedPayouts = m.payouts.filter(
    (p) => p.researcherPayoutKrw > m.limit.remaining,
  ).length;

  // 묶음에 들어간 건은 개별 목록에서 뺀다 (아래 주석 참조)
  const grouped = new Set(m.refundGroups.flatMap((g) => g.items.map((s) => s.id)));
  const soloRefunds = m.refunds.filter((s) => !grouped.has(s.id));

  const frozenKrw = m.payouts
    .filter((p) => m.frozen.some((f) => f.researcherUserId === p.purchase.report.researcher.userId))
    .reduce((s, p) => s + p.researcherPayoutKrw, 0);

  return (
    <>
      <AdminHead title="돈" />
      <main className={a.page}>
        <div className={a.subtabs}>
          {MONEY_TABS.map((t) => (
            <Link
              key={t}
              href={t === "refund" ? "/admin/settlements" : `/admin/settlements?tab=${t}`}
              className={`${a.subtab} ${tab === t ? a.subtabOn : ""}`}
            >
              {MONEY_TAB_LABEL[t]} {m.counts[t]}
              {m.stalled[t] && <span className={a.tdot} />}
            </Link>
          ))}
        </div>

        {/* ── ① 환불 — 구매자에게 돌려주는 돈. 판정이 끝나 판단이 남아 있지 않다 ── */}
        {tab === "refund" && (
          <>
            <SecHead title={<>환불 <span className={`${a.n} ${m.counts.refund === 0 ? a.nCalm : ""}`}>{m.counts.refund}</span></>}>판정이 <b>실패로 끝난 카드</b>의 구매자에게 돌려줍니다 — 판단은 이미 끝났고
                실행만 남았습니다.</SecHead>

            {/* **같은 리포트는 한 덩어리로 먼저 나온다** (시안) — 한 카드가 실패로
                판정되면 구매자 전원의 지시서가 같은 순간에 태어난다. 따로 늘어놓으면
                셋 중 둘만 누르고 화면을 뜨는 일이 생기고, 남은 하나는 "왜 나만 아직
                못 받았나"가 되어 문의로 돌아온다 */}
            {m.refundGroups.map((g) => (
              <div key={g.reportId} className={`${a.card} ${a.stripeWarn}`}>
                <div className={a.row}>
                  <span className={`${a.ttl} ${a.amt}`}>
                    {g.totalKrw.toLocaleString()}원 → 구매자 {g.items.length}명
                  </span>
                  <span className={a.chip}>같은 리포트 묶음</span>
                </div>
                <div className={a.meta}>
                  <span>
                    {g.reportTitle} · {g.outcome === "MISS" ? "예측 실패" : "판정 불가"}
                  </span>
                  <span>
                    {g.sameAmount
                      ? `각 ${g.items[0].buyerRefundKrw.toLocaleString()}원`
                      : "금액 제각각"}{" "}
                    · PG 취소
                  </span>
                </div>
                <RefundGroupButton
                  settlementIds={g.items.map((s) => s.id)}
                  totalKrw={g.totalKrw}
                />
              </div>
            ))}

            {/* 묶인 건은 여기 다시 나오지 않는다 — 같은 지시서가 두 자리에 있으면
                한쪽에서 누른 뒤 다른 쪽이 아직 남아 있는 것처럼 보인다 */}
            {m.refunds.length === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                실행할 환불이 없습니다
              </div>
            ) : soloRefunds.length === 0 ? null : (
              soloRefunds.map((s) => (
                <div key={s.id} className={`${a.card} ${a.stripeWarn}`}>
                  <div className={a.row}>
                    <span className={`${a.ttl} ${a.amt}`}>
                      {s.buyerRefundKrw.toLocaleString()}원 →{" "}
                      {maskPerson(s.purchase.buyer.penName ?? s.purchase.buyer.email)}
                    </span>
                    <span className={a.chip}>
                      {s.outcome === "MISS" ? "예측 실패" : "판정 불가"}
                    </span>
                  </div>
                  <div className={a.meta}>
                    <span>{s.purchase.report.title}</span>
                    <span>판정 {fmtDate(s.settledAt)}</span>
                    <span>결제 {fmtDate(s.purchase.paidAt)}</span>
                  </div>
                  <ExecuteButton
                    kind="REFUND"
                    settlementId={s.id}
                    stuckAttemptId={s.refundAttempts[0]?.id}
                    stuckAttemptMethod={s.refundAttempts[0]?.method}
                  />
                </div>
              ))
            )}
          </>
        )}

        {/* ── ② 지급 — 금액이 커서 한도·쿨다운이 붙는 유일한 갈래 ── */}
        {tab === "payout" && (
          <>
            <SecHead title={<>지급 <span className={`${a.n} ${m.counts.payout === 0 ? a.nCalm : ""}`}>{m.counts.payout}</span></>}>적중한 카드의 <b>리서처 정산금</b>입니다. 금액이 커서 한도·쿨다운이 붙는
                {blockedPayouts > 0
                  ? ` 유일한 갈래이고, ${blockedPayouts}건이 오늘 막혀 있습니다.`
                  : " 유일한 갈래입니다."}</SecHead>

            {m.payouts.length === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                지급할 정산이 없습니다
              </div>
            ) : (
              m.payouts.map((s) => {
                const blocked = s.researcherPayoutKrw > m.limit.remaining;
                // 금액이 클수록 눈에 걸리게 — 2인 승인 문턱과 그 절반
                const big = s.researcherPayoutKrw >= DUAL_APPROVAL_THRESHOLD_KRW;
                return (
                  <div
                    key={s.id}
                    className={`${a.card} ${blocked ? a.stripeNeg : big ? a.stripeWarn : ""}`}
                  >
                    <div className={a.row}>
                      <span className={`${a.ttl} ${a.amt}`}>
                        {s.researcherPayoutKrw.toLocaleString()}원 →{" "}
                        {s.purchase.report.researcher.user.penName ??
                          s.purchase.report.researcher.user.email}
                      </span>
                      {blocked ? (
                        <span className={`${a.chip} ${a.chipWarn}`}>한도 초과</span>
                      ) : (
                        <span className={a.chip}>적중 정산</span>
                      )}
                    </div>
                    <div className={a.meta}>
                      <span>{s.purchase.report.title}</span>
                      <span>수수료 {s.platformFeeKrw.toLocaleString()}원</span>
                      <span>판정 {fmtDate(s.settledAt)}</span>
                    </div>
                    {blocked ? (
                      <>
                        <div className={`${a.note} ${a.noteNeg}`}>
                          오늘 남은 한도는 <b>{m.limit.remaining.toLocaleString()}원</b>입니다 —
                          이 건은 지금 실행되지 않습니다. 한도는 자정에 초기화되고, 그동안
                          리포트·판정·계좌를 다시 볼 시간이 생깁니다.
                        </div>
                        <div className={a.btnrow}>
                          <button type="button" className={`${a.btn} ${a.blocked}`} disabled>
                            지급 실행<span className={a.fp}>🔒</span>
                          </button>
                        </div>
                        <div className={a.gate}>
                          일일 출금 한도에 막혀 있습니다 — 한도는 배포로만 바뀝니다
                        </div>
                      </>
                    ) : (
                      <>
                        {big && (
                          <div className={`${a.note} ${a.noteWarn}`}>
                            큰 금액입니다 — 실행 전에 리포트·판정·계좌를 한 번 더 확인하세요.
                          </div>
                        )}
                        <ExecuteButton kind="PAYOUT" settlementId={s.id} />
                      </>
                    )}
                  </div>
                );
              })
            )}

            {/* 쿨다운 건은 누를 수 없으니 목록에 그리지 않지만, 존재까지 안 보이면
                "오늘 나갈 돈이 없다"고 착각한다 */}
            {m.hold.count > 0 && (
              <div className={a.card} style={{ opacity: 0.72 }}>
                <div className={a.row}>
                  <span className={`${a.ttl} ${a.amt}`}>
                    {m.hold.amountKrw.toLocaleString()}원 · {m.hold.count}건
                  </span>
                  <span className={a.chip}>쿨다운 대기</span>
                </div>
                <div className={a.meta}>
                  <span>판정 직후 {SETTLEMENT_COOLDOWN_HOURS}시간 보류</span>
                  {m.hold.nextExecutableAt && (
                    <span>{fmtDate(m.hold.nextExecutableAt)} 해제</span>
                  )}
                  <span>지금이 되돌릴 수 있는 시간</span>
                </div>
              </div>
            )}

            {/* 숫자는 여기, 버튼은 보안에. 안 보이면 "오늘 나갈 돈이 없다"고 착각한다.
                띠를 달지 않는 이유: 동결된 지급은 **막혀 있는 것이 정상**이라 급하지 않고,
                색을 주면 정렬에서 진짜 급한 건 위로 올라가며 무엇보다 해제를 부추긴다 */}
            {m.frozen.length > 0 && (
              <Link href="/admin/frozen" className={a.xref}>
                <span>
                  동결된 지급 <b>{m.frozen.length}건{frozenKrw > 0 && ` · ${frozenKrw.toLocaleString()}원`}</b>{" "}
                  <small>— 본인이 잠갔습니다</small>
                </span>
                <span className={a.go}>›</span>
              </Link>
            )}
          </>
        )}

        {/* ── ③ 보상 — 우리 자본이 나가는 유일한 갈래 ── */}
        {tab === "comp" && (
          <>
            <SecHead title={<>플랫폼 귀책 보상{" "}
                <span className={`${a.n} ${m.counts.comp === 0 ? a.nCalm : ""}`}>{m.counts.comp}</span></>}>우리 잘못으로 판정이 안 된 카드를 <b>우리 자본</b>으로 물어줍니다 — 나머지
                셋은 남의 돈을 옮기는 일이고, 이것만 회사 돈이 줄어듭니다.</SecHead>

            <div className={a.card} style={{ padding: "12px 16px" }}>
              <div className={a.gauge}>
                <div className={a.gHead}>
                  <span>이달 보상 예산</span>
                  <span className={a.amt}>
                    {Math.round(m.budget.ratio * 100)}% · {m.budget.spent.toLocaleString()} /{" "}
                    {m.budget.cap.toLocaleString()}원
                  </span>
                </div>
                <div className={a.gTrack}>
                  <div
                    className={`${a.gFill} ${m.budget.ratio >= 0.8 ? a.gFillWarn : ""}`}
                    style={{ width: `${m.budget.ratio * 100}%` }}
                  />
                </div>
              </div>
            </div>

            {m.counts.comp === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                확정하거나 실행할 보상이 없습니다
              </div>
            ) : (
              <>
                {m.compReviews.map((g) => (
                  <div key={g.predictionCardId} className={a.card}>
                    <div className={a.row}>
                      <span className={`${a.ttl} ${a.amt}`}>
                        {g.totalKrw.toLocaleString()}원 →{" "}
                        {compNames.get(g.researcherUserId) ?? g.researcherUserId}
                      </span>
                      <span className={`${a.chip} ${a.chipWarn}`}>확정 대기</span>
                    </div>
                    <div className={a.meta}>
                      <span>{g.rows[0]?.purchase.report.title}</span>
                      <span>사유 {g.causeLabel}</span>
                      <span>구매 {g.rows.length}건</span>
                      {g.researcherUnjudgeableCards >= 2 && (
                        <span>이 리서처 180일 판정 불가: {g.researcherUnjudgeableCards}장</span>
                      )}
                    </div>
                    <CompensationReview predictionCardId={g.predictionCardId} />
                  </div>
                ))}

                {m.compExecutable.map((c) => (
                  <div key={c.id} className={`${a.card} ${a.stripeWarn}`}>
                    <div className={a.row}>
                      <span className={`${a.ttl} ${a.amt}`}>
                        {c.amountKrw.toLocaleString()}원 →{" "}
                        {compNames.get(c.researcherUserId) ?? c.researcherUserId}
                      </span>
                      <span className={`${a.chip} ${a.chipMint}`}>승인됨 — 이체 대기</span>
                    </div>
                    <div className={a.meta}>
                      <span>{c.purchase.report.title}</span>
                      <span>은행 이체 먼저, 참조번호로 기록</span>
                    </div>
                    <CompensationExecute compensationId={c.id} />
                  </div>
                ))}
              </>
            )}
          </>
        )}

        {/* ── ④ 되돌리기 — 판매 자체를 없던 일로 만드는 갈래 ── */}
        {tab === "undo" && (
          <>
            <SecHead title={<>거래 되돌리기{" "}
                <span className={`${a.n} ${m.counts.undo === 0 ? a.nCalm : ""}`}>{m.counts.undo}</span></>}>판정 결과와 무관하게 <b>판매 자체가 없던 일</b>이 됩니다 — 결제 취소처럼
                앞단이 깨진 건이라, 앱 밖(토스 콘솔·CLI)에서 끝내고 여기엔 기록만 남깁니다.</SecHead>

            {m.manualVoids.length === 0 ? (
              <div className={a.empty}>
                <span className={a.dot} />
                PG에 묶인 건이 없습니다
              </div>
            ) : (
              m.manualVoids.map((p) => (
                <div key={p.id} className={`${a.card} ${a.stripeNeg}`}>
                  <div className={a.row}>
                    <span className={a.ttl}>
                      결제 취소 실패 — {p.amountKrw.toLocaleString()}원
                    </span>
                    <span className={`${a.chip} ${a.chipNeg}`}>PG에 묶임</span>
                  </div>
                  <div className={a.meta}>
                    <span>{maskPerson(p.buyer.penName ?? p.buyer.email)}</span>
                    <span>구매자는 돈만 빠지고 상품이 없는 상태</span>
                    <span>{fmtDate(p.createdAt)}</span>
                  </div>
                  <div className={`${a.note} ${a.noteNeg}`}>
                    토스 콘솔에서 직접 취소해야 합니다.
                  </div>
                  <div className={a.lbl}>주문번호</div>
                  <pre className={a.cmd}>{p.orderId}</pre>
                </div>
              ))
            )}

            <div className={a.xref}>
              <span>
                CS 구매 무효화 · 차지백 <small>— CLI 전용 (npm run cs:void)</small>
              </span>
            </div>
          </>
        )}

        {/* ── ⑤ 문의 — 실행 큐와 시계가 다르게 간다 ── */}
        {tab === "ask" && (
          <>
            <SecHead title={<>돈 관련 문의{" "}
                <span className={`${a.n} ${m.counts.ask === 0 ? a.nCalm : ""}`}>{m.counts.ask}</span></>}>환불·정산이 <b>안 들어왔다</b>는 문의입니다. 대부분 우리 기록에 답이 이미
                있어 <b>확인해 주는 일</b>이지 처리하는 일이 아닙니다 — 실행 큐와 섞으면
                그 차이가 사라집니다.</SecHead>

            <DeskTickets
              tickets={m.asks}
              now={now}
              emptyLabel="답변을 기다리는 돈 문의가 없습니다"
            />
          </>
        )}

        {/* ── 한도는 탭 밖, 화면 맨 끝 ────────────────────────────
            탭과 무관하게 늘 같은 값이라 어느 탭에서 내려와도 같은 것이 보인다 */}
        <div className={a.sec}>오늘의 한도</div>
        <div className={a.card} style={{ padding: "14px 16px" }}>
          <div className={a.gauge}>
            <div className={a.gHead}>
              <span>오늘 나간 돈</span>
              <span
                className={a.amt}
                style={m.limit.ratio >= 0.8 ? { color: "#b45309" } : undefined}
              >
                {m.limit.spent.toLocaleString()} / {m.limit.cap.toLocaleString()}원
              </span>
            </div>
            <div className={a.gTrack}>
              <div
                className={`${a.gFill} ${m.limit.ratio >= 0.8 ? a.gFillWarn : ""}`}
                style={{ width: `${m.limit.ratio * 100}%` }}
              />
            </div>
          </div>
          <div className={a.gSum}>
            <span>지금 실행 대기</span>
            <span className={a.gSumV}>
              {m.limit.waiting}건 · {m.limit.waitingKrw.toLocaleString()}원
            </span>
          </div>
          {m.limit.blocked.length > 0 && (
            <div className={a.gWarn}>
              남은 한도는 {m.limit.remaining.toLocaleString()}원입니다 —{" "}
              <b>
                {m.limit.blocked.map((n) => `${n.toLocaleString()}원`).join(" · ")} 지급은 오늘
                실행되지 않습니다.
              </b>{" "}
              자정에 한도가 초기화됩니다.
            </div>
          )}
        </div>

        <p className={a.hint}>
          이의가 걸린 건은 이 목록에서 아예 빠집니다 — 왜 안 보이는지 알 길이 이 링크뿐이라,
          없으면 &ldquo;지급이 사라졌다&rdquo;로 읽힙니다.{" "}
          <Link href="/admin/disputes">판정 이의 →</Link>{" "}
          <Link href="/admin/compliance?tab=inst">판정 보류 큐 →</Link>
        </p>
      </main>
    </>
  );
}
