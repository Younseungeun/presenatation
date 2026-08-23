import Link from "next/link";
import { notFound } from "next/navigation";
import type { JudgmentAudit } from "@/domain/judgmentPipeline";
import { prisma } from "@/server/db";
import {
  DISPUTE_CATEGORIES,
  getOpenDisputes,
  getUpheldPendingRevert,
  type DisputeCategory,
  type OpenDispute,
} from "@/server/judgmentDisputeService";
import { getSessionUserId } from "@/server/session";
import { AdminHead } from "../AdminHead";
import { fmtDayMonth as fmtDate } from "@/lib/format";
import { ResolveForm } from "./ResolveForm";
import q from "./disputes.module.css";
import a from "../admin.module.css";

export const dynamic = "force-dynamic";

// 운영자 이의 큐 — **접수가 정산을 잠그므로, 푸는 화면이 없으면 잠금이 곧 영구 동결이다.**
//
// 이 화면의 일은 하나다: **판정이 쓴 시세와 구매자가 본 값을 한 화면에 나란히 놓는 것.**
// 둘을 다른 곳에서 봐야 하면 운영자는 매번 옮겨 적게 되고, 옮겨 적는 순간 틀린다.
// 그래서 감사 스냅샷(Judgment.marketSnapshotJson)의 일봉을 시한 근처만 잘라 보여준다 —
// 판정에 실제로 쓰인 원본이지 지금 다시 조회한 값이 아니다(지금 값으로 비교하면
// 권리 사건이 있었을 때 둘 다 바뀌어 있어 아무것도 증명하지 못한다).
//
// **인정해도 판정을 자동으로 되돌리지 않는다** (judgmentDisputeService 주석). 그래서
// 아래에 "인정했는데 아직 안 되돌린 건"을 따로 세워 둔다 — 그 목록이 없으면
// "오류가 확인되었습니다"라고 알린 뒤 아무 일도 안 일어나는 건이 조용히 쌓인다.

/** 감사 스냅샷에서 시한 근처 일봉만 — 전부 그리면 90줄이 되어 아무도 안 본다 */
function nearbyQuotes(snapshot: string | null, take = 5) {
  if (!snapshot) return null;
  try {
    const audit = JSON.parse(snapshot) as JudgmentAudit;
    if (!Array.isArray(audit.quotes)) return null;
    return {
      source: audit.dataSource,
      fetchedAt: audit.fetchedAt,
      halted: audit.securityStatus?.halted ?? false,
      delisted: audit.securityStatus?.delisted ?? false,
      rows: audit.quotes.slice(-take),
    };
  } catch {
    return null;
  }
}

/**
 * 되돌리기 갈래를 **이의 사유가 제안한다.**
 *
 * `judgment:revert`는 `--source`(시세 소스 오류 → 자동 판정 금지, 사람 큐로)와
 * `--logic`(우리 판정 로직 버그 → 고친 코드로 자동 재판정) 중 하나를 반드시 받는다.
 * 구매자가 고른 사유가 이미 그 답에 가깝다 — 시세·권리 사건은 데이터 쪽이고,
 * 판정 시각 적용은 우리 쪽이다. **제안일 뿐 강제가 아니다**: 운영자가 조사한 결과가
 * 다르면 반대 갈래로 실행하면 된다.
 */
const REVERT_FLAG: Record<DisputeCategory, "--source" | "--logic"> = {
  PRICE_DATA: "--source",
  CORPORATE_ACTION: "--source",
  TIMING: "--logic",
  OTHER_SYSTEM: "--logic",
};

/** 화면에 적는 명령은 **그대로 붙여넣어 도는 것**이어야 한다 — 틀 하나만 적으면 다시 찾아야 한다 */
function revertCommand(judgmentId: string, operatorEmail: string, category: string, resolution: string | null) {
  const flag = REVERT_FLAG[category as DisputeCategory] ?? "--logic";
  const reason = (resolution ?? "판정 이의 인정").replace(/"/g, "'").slice(0, 80);
  return `npm run judgment:revert -- ${judgmentId} ${operatorEmail} "${reason}" ${flag}`;
}

function claimText(card: NonNullable<OpenDispute["judgment"]>["predictionCard"]) {
  const dir = card.direction === "UP" ? "상승" : "하락";
  return card.targetType === "RETURN_PCT"
    ? `${dir} ${card.targetValue}%`
    : `${dir} · 목표가 ${card.targetValue.toLocaleString()}`;
}

export default async function AdminDisputesPage() {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, email: true },
  });
  if (user?.role !== "OPERATOR") notFound();

  const [open, pendingRevert] = await Promise.all([
    getOpenDisputes(prisma),
    getUpheldPendingRevert(prisma),
  ]);

  return (
    <>
      <AdminHead title="판정 이의" backHref="/admin/settlements" />
      <main className={a.page}>
        <div className={a.sech}>
          <div>
            <p className={a.sechDesc}>
              구매자가 낸 판정 이의입니다. <strong>접수된 건은 정산이 멈춰 있습니다</strong> —
              확정해야 지급이 다시 열립니다.{" "}
              <Link href="/admin/settlements">정산 지시서 →</Link>
            </p>
          </div>
        </div>

        <div className={a.statGrid}>
          <div className={a.stat}>
            <span className={a.statLabel}>대기 중 (정산 잠김)</span>
            <span className={a.statValue}>{open.length}건</span>
          </div>
          <div className={a.stat}>
            <span className={a.statLabel}>인정 후 미조치</span>
            <span className={a.statValue}>{pendingRevert.length}건</span>
          </div>
        </div>

        <div className={a.sec}>대기 중인 이의</div>
        {open.length === 0 ? (
          <div className={a.empty}>
            <span className={a.dot} />
            접수된 이의가 없어요
          </div>
        ) : (
          open.map((d) => {
            const card = d.judgment?.predictionCard;
            const snap = nearbyQuotes(d.judgment?.marketSnapshotJson ?? null);
            return (
              <div key={d.id} className={a.card}>
                <div className={a.row}>
                  <div className={a.ttl}>
                    {card ? `${card.assetName} (${card.ticker})` : "판정이 되돌려진 건"}
                  </div>
                  {/* 이용자 화면의 StatusChip을 쓰지 않는다 — 저기는 "내 카드가 어떻게
                      됐나"를 알리는 색이고, 여기는 큐를 훑는 색이다. 관리 화면의 칩은
                      admin.module.css 한 곳에서만 나온다 */}
                  {d.judgment && (
                    <span
                      className={`${a.chip} ${
                        d.judgment.outcome === "HIT"
                          ? a.chipMint
                          : d.judgment.outcome === "MISS"
                            ? a.chipNeg
                            : a.chipWarn
                      }`}
                    >
                      {d.judgment.outcome === "HIT"
                        ? "적중 판정"
                        : d.judgment.outcome === "MISS"
                          ? "실패 판정"
                          : "판정 불가"}
                    </span>
                  )}
                </div>
<div className={a.meta}>
                  <span>접수 {fmtDate(d.createdAt)}</span>
                  {/* 리서처 이의는 구매에 붙지 않는다 — 판정 자체에 붙는다 */}
                  {d.purchase ? (
                    <>
                      <span>결제 {d.purchase.amountKrw.toLocaleString()}원</span>
                      <Link href={`/report/${d.purchase.reportId}`}>리포트 →</Link>
                    </>
                  ) : (
                    <>
                      <span>정산 흐름 영향 없음</span>
                      {card && <Link href={`/report/${card.reportId}`}>리포트 →</Link>}
                    </>
                  )}
                </div>

                {/* **대조가 이 화면의 전부다** — 우리가 쓴 값과 구매자가 본 값을 나란히 */}
                <div className={q.claim}>
<div className={q.side}>
                    <span className={q.sideLabel}>
                      {d.actorRole === "RESEARCHER" ? "리서처의 주장" : "구매자의 주장"}
                    </span>
                    <p className={q.category}>{DISPUTE_CATEGORIES[d.category as DisputeCategory] ?? d.category}</p>
                    {/* 리서처는 맞다고 보는 가격을 반드시 적는다 — 그것이 남용 방지 장치다 */}
                    {d.claimedPrice != null && (
                      <p className={q.observed}>주장 가격 {d.claimedPrice.toLocaleString()}</p>
                    )}
                    {d.observed ? (
                      <p className={q.observed}>{d.observed}</p>
                    ) : (
                      d.claimedPrice == null && <p className={q.none}>확인한 값을 적지 않았습니다</p>
                    )}
                  </div>
                  <div className={q.side}>
                    <span className={q.sideLabel}>우리가 판정에 쓴 값</span>
                    {d.judgment && card ? (
                      <>
                        <p className={q.observed}>
                          판정가 {d.judgment.settledPrice?.toLocaleString() ?? "—"}
                          {d.judgment.realizedReturnPct != null &&
                            ` (${d.judgment.realizedReturnPct.toFixed(2)}%)`}
                        </p>
                        <p className={q.none}>
                          기준가 {card.basePrice?.toLocaleString() ?? "—"} · {claimText(card)} ·
                          시한 {fmtDate(card.deadline)} · 판정 {fmtDate(d.judgment.judgedAt)}
                        </p>
                      </>
                    ) : (
                      <p className={q.none}>이 판정은 이미 되돌려졌습니다</p>
                    )}
                  </div>
                </div>

                {/* 판정 당시의 원본 일봉 — 지금 다시 조회한 값이 아니다 */}
                {snap && (
                  <div className={q.snapshot}>
                    <div className={q.snapshotHead}>
                      판정에 쓴 원본 시세 · {snap.source} · 조회 {snap.fetchedAt.slice(0, 10)}
                      {snap.halted && " · 거래정지"}
                      {snap.delisted && " · 상장폐지"}
                    </div>
                    <table className={q.table}>
                      <tbody>
                        {snap.rows.map((r) => (
                          <tr key={r.date}>
                            <td>{r.date}</td>
                            <td>고 {r.high.toLocaleString()}</td>
                            <td>저 {r.low.toLocaleString()}</td>
                            <td className={q.close}>종 {r.close.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <ResolveForm disputeId={d.id} />
              </div>
            );
          })
        )}

        {/* 인정만 하고 끝내면 구매자에게는 "오류가 확인되었습니다"만 남는다 */}
        {pendingRevert.length > 0 && (
          <>
            <div className={a.sec}>인정했지만 아직 되돌리지 않은 판정</div>
            <p className={a.hint}>
              인정은 판단이고 되돌리기는 돈을 움직이는 별도 절차입니다(그래서 버튼 하나로
              묶지 않았습니다). 아래 명령을 그대로 붙여넣어 실행하면 이 목록에서 자동으로
              사라집니다. <strong>갈래(--source / --logic)는 이의 사유가 낸 제안</strong>이니
              조사 결과가 다르면 바꿔서 실행하세요.
            </p>
            {pendingRevert.map((d) => (
              <div key={d.id} className={a.card}>
                <div className={a.row}>
                  <div className={a.ttl}>
                    {d.judgment?.predictionCard.assetName} ({d.judgment?.predictionCard.ticker})
                  </div>
                  <span className={a.chip}>인정 {d.resolvedAt ? fmtDate(d.resolvedAt) : ""}</span>
                </div>
                <div className={a.meta}>
                  <span>{d.resolution}</span>
                </div>
                <pre className={a.cmd}>
                  {revertCommand(d.judgment!.id, user.email, d.category, d.resolution)}
                </pre>
              </div>
            ))}
          </>
        )}
      </main>
    </>
  );
}
