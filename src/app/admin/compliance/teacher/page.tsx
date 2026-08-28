import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getTeacherPackDetails } from "@/server/teacherAnswerQueue";
import { getDetectionLadder } from "@/server/detectionLadderService";
import { fmtDayMonth as fmtDate } from "@/lib/format";
import { AdminHead } from "../../AdminHead";
import a from "../../admin.module.css";
import { SecHead } from "../../Why";
import { DetectionLadderTable } from "../DetectionLadderTable";
import { TeacherBatchCopy } from "../TeacherBatchCopy";

export const dynamic = "force-dynamic";

// 재학습 논의 자료 상세 (2026-08-28 창업자 지시) — 박스에서 눌러 들어와, 복사하지 않고도
// 쌓인 질문지 원문을 직접 읽는다. 판정 시점에 저장된 케이스별 질문지를 그대로 편다.

const VERDICT_LABEL: Record<string, string> = {
  APPROVED: "게시 승인",
  REJECTED: "반려",
  TAKEDOWN: "강제 철회",
  MISSED: "미탐",
  KEPT: "게시 유지",
};

export default async function TeacherPackDetailPage() {
  const userId = await getSessionUserId();
  const me = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    : null;
  if (me?.role !== "OPERATOR") {
    return (
      <>
        <AdminHead title="재학습 논의 자료" backHref="/admin/compliance" />
        <main className={a.page}>
          <div className={a.empty}>운영자만 볼 수 있는 화면입니다.</div>
        </main>
      </>
    );
  }

  const [packs, ladder] = await Promise.all([
    getTeacherPackDetails(prisma),
    getDetectionLadder(prisma),
  ]);

  return (
    <>
      <AdminHead title="재학습 논의 자료" backHref="/admin/compliance" />
      <main className={a.page}>
        <SecHead title="사건별 질문지">판정마다 저장된 케이스별 재학습 논의 자료입니다.</SecHead>
        <div
          className={a.note}
          style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}
        >
          <span>
            판정 시점에 저장된 케이스별 질문지 <b>{packs.length}건</b>입니다. 창업자가 답을 보고
            코드로 직접 반영합니다 — 여기서 답을 다시 붙여넣지 않습니다.
          </span>
          {packs.length > 0 && <TeacherBatchCopy />}
        </div>

        {packs.length === 0 ? (
          <div className={a.empty}>
            <span className={a.dot} />
            쌓인 재학습 논의 자료가 없습니다
          </div>
        ) : (
          // **접이식** (2026-08-28 창업자 지시) — 질문지 한 건이 시스템 프롬프트 + 본문 +
          // 소견이라 매우 길다. 다 펼쳐 쌓으면 화면이 끝없어져, 제목·판정만 보이고 누르면 편다
          packs.map((p) => (
            <details key={p.reviewId} className={a.card} style={{ marginBottom: 10 }}>
              <summary
                style={{
                  cursor: "pointer",
                  listStyle: "none",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                <span className={a.go} style={{ transform: "none" }}>
                  ▸
                </span>
                <span className={a.ttl} style={{ flex: 1 }}>
                  {p.reportTitle}
                </span>
                <span style={{ fontSize: 12, color: "var(--text-faint)" }}>
                  {p.decidedAt ? fmtDate(p.decidedAt) : "—"}
                </span>
                <span className={a.chip}>{VERDICT_LABEL[p.verdict] ?? p.verdict}</span>
              </summary>
              <pre
                style={{
                  margin: "10px 0 0",
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "var(--surface-1, #f2f4f6)",
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily:
                    "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
                  color: "var(--text)",
                  maxHeight: "60vh",
                  overflowY: "auto",
                }}
              >
                {p.packText}
              </pre>
            </details>
          ))
        )}

        <DetectionLadderTable rows={ladder} />
      </main>
    </>
  );
}
