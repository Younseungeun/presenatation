import { APPROVAL_TTL_HOURS } from "@/domain/operatorApproval";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getPendingApprovals, isSoloOperatorMode } from "@/server/operatorApprovalService";
import { AdminHead } from "../AdminHead";
import { ApprovalList } from "./ApprovalList";
import { SecHead } from "../Why";
import a from "../admin.module.css";

export const dynamic = "force-dynamic";

// 운영자 2인 승인 대기열 (2026-08-16 검토 2차 Q3).
//
// 패스키와 최근성은 "들어오는 것"을 막지만, 이미 들어온 사람이 **실행하는 것**은
// 못 막는다. 악의를 품은 내부자는 정당하게 들어오기 때문이다.
// 그래서 돈이 크게 움직이는 행위는 요청과 승인을 다른 사람이 한다.

/**
 * 대기 행을 화면이 쓰는 모양으로 — **지금 시각은 여기서 한 번만 읽는다.**
 *
 * 렌더 중에 시계를 읽으면 같은 입력이 매번 다른 화면을 낳는다(린트가 막는 이유).
 * 이 화면은 요청마다 새로 그려지는 서버 화면이라 "지금"이 필요하지만, 그 불순함을
 * 컴포넌트 밖 한 곳에 가둬 둔다.
 */
function toApprovalViews(
  rows: { id: string; action: string; summary: string; amountKrw: number | null; requestedBy: string; requestedAt: Date; reason: string }[],
  viewerId: string | null,
  names: Map<string, string>,
) {
  const now = Date.now();
  return rows.map((p) => ({
    id: p.id,
    action: p.action,
    summary: p.summary,
    amountKrw: p.amountKrw,
    // 계정 id는 사람에게 아무 말도 하지 않는다 — 누가 올렸는지가 판단의 재료다
    requestedBy: names.get(p.requestedBy) ?? p.requestedBy,
    requestedAt: p.requestedAt.toISOString(),
    reason: p.reason,
    // 서버가 어차피 거절하는 것을 화면이 미리 안다 — 누르고 나서 알 일이 아니다
    mine: p.requestedBy === viewerId,
    hoursLeft: (p.requestedAt.getTime() + APPROVAL_TTL_HOURS * 3_600_000 - now) / 3_600_000,
  }));
}

export default async function ApprovalsPage() {
  const userId = await getSessionUserId();
  const me = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    : null;
  if (me?.role !== "OPERATOR") {
    return (
      <>
        <AdminHead title="승인 대기열" backHref="/admin/frozen" />
        <main className={a.page}>
          <div className={a.empty}>운영자만 볼 수 있는 화면입니다.</div>
        </main>
      </>
    );
  }

  const [pending, solo] = await Promise.all([
    getPendingApprovals(prisma),
    isSoloOperatorMode(prisma),
  ]);
  const requesters = await prisma.user.findMany({
    where: { id: { in: [...new Set(pending.map((p) => p.requestedBy))] } },
    select: { id: true, email: true, penName: true },
  });
  const names = new Map(requesters.map((u) => [u.id, u.penName || u.email]));

  return (
    <>
      <AdminHead title="승인 대기열" backHref="/admin/frozen" />
      <main className={a.page}>
        <SecHead title={<>다른 운영자의 승인을 기다리는 요청
              <span className={`${a.n} ${pending.length === 0 ? a.nCalm : ""}`}>
                {pending.length}
              </span></>}><strong>요청한 사람은 자기 요청을 승인할 수 없습니다.</strong> 운영자 계정 하나가
              뚫리거나 내부자가 악의를 품어도, 돈이 크게 움직이려면 두 사람이 필요합니다.
              요청은 {APPROVAL_TTL_HOURS}시간 뒤 만료되고, 만료되면 기안자가 사유부터 다시
              씁니다 — 낡은 판단은 다시 쓰는 편이 맞습니다.</SecHead>

        {/* 1인 운영 모드에서는 이 화면의 요청이 **전부 내 것**이라 아무것도 승인할 수
            없다. 그 사실을 화면이 말하지 않으면 눌러 보고 403을 받고서야 알게 된다 */}
        {solo && (
          <div className={`${a.note} ${a.noteNeg}`}>
            지금은 <b>1인 운영 모드</b>입니다 — 두 번째 사람이 없어 여기서 승인할 수 있는
            요청이 없습니다. 대신 <b>실행 직전 지문·얼굴 재확인</b>이 두 번째 사람의 자리를
            대신합니다. 승인은 실제 두 번째 운영자가 생긴 뒤에 이 화면에서 열립니다.
          </div>
        )}

        <ApprovalList initial={toApprovalViews(pending, userId, names)} />
      </main>
    </>
  );
}
