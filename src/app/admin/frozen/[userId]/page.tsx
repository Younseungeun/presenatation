import { notFound } from "next/navigation";
import { getAdminQueues } from "@/server/adminQueues";
import { prisma } from "@/server/db";
import { getFrozenDetail } from "@/server/frozenDetail";
import { getSessionUserId } from "@/server/session";
import { AdminHead } from "../../AdminHead";
import { UnfreezeForm } from "./UnfreezeForm";
import a from "../../admin.module.css";

export const dynamic = "force-dynamic";

// 동결 상세 — **해제 판단의 재료를 한 화면에** (시안 v3 scr-frozen).
//
// 목록은 "누가 얼마나"까지만 답한다. 풀지 말지를 정하려면 그때 무슨 일이 있었는지를
// 알아야 하는데, 그 재료가 세 표에 흩어져 있어 지금까지는 DB를 열어야 했다.

const STATUS_LABEL: Record<string, string> = {
  UNVERIFIED: "미검증",
  VERIFIED: "검증됨",
  HOLDER_MISMATCH: "명의 불일치",
};

export default async function FrozenDetailPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (me?.role !== "OPERATOR") notFound();

  const { userId: target } = await params;
  const now = new Date();
  const [d, q] = await Promise.all([
    getFrozenDetail(prisma, target, now),
    getAdminQueues(prisma, now),
  ]);
  if (!d) notFound();

  return (
    <>
      <AdminHead
        title={d.displayName}
        sub={`정산 동결 ${d.days === 0 ? "오늘" : `${d.days}일째`}`}
        backHref="/admin/frozen"
        inbox={q.inbox}
      />
      <main className={a.page}>
        <div className={a.card}>
          <div className={a.kv}>
            <span className={a.kvK}>동결한 사람</span>
            <span className={a.chip}>{d.frozenBySelf ? "본인" : "운영자"}</span>
          </div>
          <div className={a.kv}>
            <span className={a.kvK}>동결 시각</span>
            <span className={a.chip}>{new Date(d.frozenAt).toLocaleString("ko-KR")}</span>
          </div>
          <div className={a.kv}>
            <span className={a.kvK}>묶인 정산</span>
            <span className={a.chip}>
              {d.heldKrw > 0 ? `${d.heldKrw.toLocaleString()}원 · ${d.heldCount}건` : "없음"}
            </span>
          </div>
          <div className={a.kv}>
            <span className={a.kvK}>지금 계좌</span>
            <span
              className={`${a.chip} ${d.account.status === "VERIFIED" ? a.chipMint : a.chipWarn}`}
            >
              {d.account.label} · {STATUS_LABEL[d.account.status] ?? d.account.status}
            </span>
          </div>
        </div>

        {/* ── 그때 무슨 일이 있었나 ────────────────────────────── */}
        <div className={a.sec}>
          그때 무슨 일이 있었나 <small>해제 판단의 재료</small>
        </div>
        <div className={a.card}>
          <div className={a.kv}>
            <span className={a.kvK}>{d.changedJustBefore ? `동결 ${d.changedJustBefore.minutesBefore}분 전` : "동결 직전"}</span>
            {d.changedJustBefore ? (
              <span className={`${a.chip} ${a.chipWarn}`}>낯선 기기에서 계좌 변경</span>
            ) : (
              <span className={a.chip}>계좌 변경 없음</span>
            )}
          </div>
          <div className={a.kv}>
            <span className={a.kvK}>그 기기</span>
            <span className={a.chip}>
              {d.changedJustBefore?.fromUnknownDevice ? "등록된 적 없음" : "등록된 기기"}
            </span>
          </div>
          <div className={a.kv}>
            <span className={a.kvK}>그 뒤 변경</span>
            <span className={`${a.chip} ${d.changedAfter > 0 ? a.chipNeg : ""}`}>
              {d.changedAfter > 0 ? `${d.changedAfter}건` : "없음"}
            </span>
          </div>
          <div className={a.kv}>
            <span className={a.kvK}>본인 인증 재확인</span>
            <span className={`${a.chip} ${d.identityVerified ? a.chipMint : a.chipWarn}`}>
              {d.identityVerified ? "통과" : "미완료"}
            </span>
          </div>
          <div className={a.kv}>
            <span className={a.kvK}>
              등록 기기 <small>생체 · 간편 비밀번호</small>
            </span>
            <span className={a.chip}>
              패스키 {d.passkeys} · 기기 {d.devices}
            </span>
          </div>

          {d.changedJustBefore ? (
            <div className={`${a.note} ${a.noteNeg}`}>
              계좌가 바뀐 <b>직후</b> 동결이 걸렸습니다 — 진짜 신호였을 가능성이 있습니다.
              본인이 &ldquo;제가 바꾼 것&rdquo;이라고 해도, 그 말을 <b>어느 경로로 들었는지</b>를
              먼저 보세요. 계정을 쥔 사람도 똑같이 말합니다.
            </div>
          ) : (
            <div className={a.note}>
              동결 직전에 계좌 변경이 없었습니다 — 다른 이유로 걸었을 수 있으니 본인에게서
              그 이유를 들으세요.
            </div>
          )}
        </div>

        {/* ── 이력 ─────────────────────────────────────────────── */}
        <div className={a.sec}>이력</div>
        {/* 문으로 둔다 — 건별 내역을 여는 화면은 아직 없다(design-backlog A).
            없는 것을 있는 척하지 않되, 자리는 시안대로 남겨 둔다 */}
        <div className={a.xref}>
          <span>계좌 변경 이력 {d.historyCount}건</span>
          <span className={a.go}>›</span>
        </div>
        <div className={a.xref}>
          <span>로그인 기기 {d.passkeys + d.devices}대</span>
          <span className={a.go}>›</span>
        </div>

        {/* ── 해제 ─────────────────────────────────────────────── */}
        <div className={a.sec}>해제</div>
        <div className={a.card}>
          <div className={a.note} style={{ marginTop: 0 }}>
            해제해도 <b>계좌 검증 상태는 그대로</b>입니다 — &ldquo;지급을 다시 연다&rdquo;일
            뿐입니다. 방어를 스스로 여는 유일한 행위라, 확인한 내용을 남겨야 하고 실행에는
            지문이 섭니다.
          </div>
          <UnfreezeForm researcherUserId={d.researcherUserId} />
        </div>
      </main>
    </>
  );
}
