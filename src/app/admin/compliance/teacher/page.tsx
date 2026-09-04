import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getTeacherPackDetails } from "@/server/teacherAnswerQueue";
import { getDetectionLadder } from "@/server/detectionLadderService";
import { getArgosCategoryCounts, ARGOS_ITEM_PREFIX } from "@/server/itemTeacherPackService";
import { RISK_CATEGORY_LABEL } from "@/domain/compliance";
import { fmtDayMonth as fmtDate } from "@/lib/format";
import { AdminHead } from "../../AdminHead";
import a from "../../admin.module.css";
import { SecHead } from "../../Why";
import { DetectionLadderTable } from "../DetectionLadderTable";
import { TeacherBatchCopy } from "../TeacherBatchCopy";
import { ItemPackButton } from "../ItemPackButton";
import { ArgosRegisterForm } from "../ArgosRegisterForm";

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

  const [packs, ladder, argosCounts] = await Promise.all([
    getTeacherPackDetails(prisma),
    getDetectionLadder(prisma),
    getArgosCategoryCounts(prisma),
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

        {/* ARGOS 유형별 문장 모음 (2026-09-01) — 졸업 강등 **본선**("계속 보다 보니 공식화 가능")을
            지탱하는 자리. ARGOS 소견은 문장을 짚지 못하므로 재료는 운영자가 반려 때 짚은 근거
            문장뿐이다. 규칙·사전이 낸 소견이 있던 건은 여기 없다(그건 항목 질문지의 몫) */}
        <section style={{ marginTop: 22 }}>
          <SecHead title="ARGOS 유형별 문장 모음 — 졸업 강등 본선 재료">
            규칙·사전은 못 잡고 <b>ARGOS만 잡았거나 그마저 놓친</b> 확정 위반의 근거 문장을
            유형별로 모읍니다. <b>ARGOS 미탐(코드가 받쳐줄 확정 위반)이 많은 유형이 위</b>로 옵니다
            — 위에서부터 보며 &ldquo;이건 코드로 적을 수 있겠다&rdquo; 싶으면 질문지를 뽑아 공식화를
            논의하세요. 순서는 <b>어디부터 볼지</b>를 줄 뿐이고, 코드화가 되는지는 공식화 샌드박스가
            판별합니다. 재료는 반려 때 <b>짚은 근거 문장</b>이라, ARGOS만 잡은 건은 짚지 않으면
            반려가 안 됩니다.
          </SecHead>
          {argosCounts.length === 0 ? (
            <div className={a.empty}>
              <span className={a.dot} />
              아직 모인 문장이 없습니다 — ARGOS만 잡은 건을 반려하며 근거 문장을 짚으면 쌓입니다
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                    <th style={{ padding: "8px 10px", fontWeight: 600 }}>유형</th>
                    <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>확정 건</th>
                    <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>ARGOS 검출</th>
                    <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>ARGOS 미탐</th>
                    <th style={{ padding: "8px 10px", fontWeight: 600, textAlign: "right" }}>문장</th>
                  </tr>
                </thead>
                <tbody>
                  {argosCounts.map((c, i) => (
                    <tr key={c.category} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ padding: "8px 10px", verticalAlign: "top" }}>
                        {RISK_CATEGORY_LABEL[c.category]}
                        {/* "여기부터 보라" (13차 검토 A·Q6-1) — ARGOS 미탐이 있고 그중 맨 위 유형에만.
                            문턱 컷이 아니라 상대 순위 강조라 근거 없는 상수를 안 만든다.
                            "코드화 후보"라는 말은 쓰지 않는다 — 거짓 확신을 만든다(Q6-1) */}
                        {i === 0 && c.missed > 0 && (
                          <span className={`${a.chip} ${a.chipWarn}`} style={{ marginLeft: 6 }}>여기부터</span>
                        )}
                        <ItemPackButton itemId={`${ARGOS_ITEM_PREFIX}${c.category}`} />
                        {/* 본선 실행 통로 (Q1) — 질문지를 보고 "코드로 내리자" 정했으면 여기서 등록 */}
                        <ArgosRegisterForm category={c.category} />
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{c.cases}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{c.detected}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", verticalAlign: "top", fontVariantNumeric: "tabular-nums", color: c.missed > 0 ? "#bd4242" : undefined }}>{c.missed}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{c.sentences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
