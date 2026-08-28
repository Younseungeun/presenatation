import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { getDetectionLadder, type DetectionLadderRow } from "@/server/detectionLadderService";
import { LADDER_THRESHOLDS, type LadderRecommendationKind } from "@/domain/detectionLadder";
import { AdminHead } from "../AdminHead";
import { SecHead } from "../Why";
import a from "../admin.module.css";

export const dynamic = "force-dynamic";

// 검출 항목 관리 — 승격/강등 사다리 대시보드 (2026-08-28, 회신 25~26호 관문 설계).
//
// 쌓인 증거(운영자 판정)를 읽어 각 검출 항목(규칙·학습표현)의 성적을 보여주고, 어느
// 관문 조건에 닿았는지 **추천**한다. **실행 버튼은 없다** — 층 이동은 각각 게이트를 타는
// 사람의 일(개발자가 규칙 쓰거나, IRIS 재학습 돌리거나). 문턱 숫자는 전부 초안이다.

const LAYER_LABEL: Record<DetectionLadderRow["layer"], string> = {
  PHRASE: "학습표현",
  RULE_WARN: "규칙 WARN",
  RULE_BLOCK: "규칙 BLOCK",
  IRIS: "IRIS",
};

const REC: Record<LadderRecommendationKind, { label: string; color: string }> = {
  PROMOTE_RULE: { label: "▲ 규칙 WARN 승격", color: "#0e6f5c" },
  GRADUATE_IRIS: { label: "↗ IRIS 졸업", color: "#2a6fb0" },
  PROMOTE_BLOCK: { label: "▲ BLOCK 승격 자격", color: "#0e6f5c" },
  DEMOTE_IRIS: { label: "▼ IRIS 강등", color: "#bd4242" },
};

export default async function DetectionLadderPage() {
  const userId = await getSessionUserId();
  const me = userId
    ? await prisma.user.findUnique({ where: { id: userId }, select: { role: true } })
    : null;
  if (me?.role !== "OPERATOR") {
    return (
      <>
        <AdminHead title="검출 항목 관리" />
        <main className={a.page}>
          <div className={a.empty}>운영자만 볼 수 있는 화면입니다.</div>
        </main>
      </>
    );
  }

  const rows = await getDetectionLadder(prisma);
  const withRec = rows.filter((r) => r.recommendation);

  return (
    <>
      <AdminHead title="검출 항목 관리" />
      <main className={a.page}>
        <SecHead title="검출 항목 관리 — 승격·강등 사다리">
          쌓인 증거로 각 검출 항목이 어느 층에 있고, 어느 관문 조건에 닿았는지 짚습니다.
          <b>추천만</b> 냅니다 — 실제 층 이동은 각각 게이트를 타는 사람의 일입니다(개발자가
          규칙을 쓰거나, IRIS 를 재학습시키거나). 문턱 숫자
          (걸림 {LADDER_THRESHOLDS.phraseMinMatched}·형태 ≤{LADDER_THRESHOLDS.formMaxSurfaces}종·
          BLOCK {LADDER_THRESHOLDS.blockMinMatched}건 등)는 <b>전부 초안</b>이라, 운영 표본이
          쌓이면 재보정합니다.
        </SecHead>

        {rows.length === 0 ? (
          <div className={a.empty}>
            아직 판정 데이터가 없습니다 — 운영자 판정이 쌓이면 여기에 항목이 뜹니다.
            <br />
            (출시 후 리서처가 글을 쓰고 운영자가 판정하면 채워지는 화면입니다.)
          </div>
        ) : (
          <>
            {withRec.length > 0 && (
              <div className={`${a.note}`}>
                추천 이동이 있는 항목 <b>{withRec.length}건</b> — 아래 표 상단에 모았습니다.
              </div>
            )}
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "var(--text-dim)" }}>
                    <th style={th}>검출 항목</th>
                    <th style={th}>층</th>
                    <th style={thNum}>걸림</th>
                    <th style={thNum}>정탐</th>
                    <th style={thNum}>오탐</th>
                    <th style={th}>형태</th>
                    <th style={th}>추천 이동</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                      <td style={{ ...td, maxWidth: 260, wordBreak: "break-word" }}>{r.label}</td>
                      <td style={td}>{LAYER_LABEL[r.layer]}</td>
                      <td style={tdNum}>{r.matched}</td>
                      <td style={tdNum}>{r.truePos}</td>
                      <td style={{ ...tdNum, color: r.falsePos > 0 ? "#bd4242" : undefined }}>
                        {r.falsePos}
                      </td>
                      <td style={{ ...td, color: "var(--text-faint)" }}>
                        {r.layer === "PHRASE" && r.distinctSurfaces != null
                          ? `${r.distinctSurfaces}종·최빈 ${Math.round((r.topSurfaceShare ?? 0) * 100)}%`
                          : "—"}
                      </td>
                      <td style={td}>
                        {r.recommendation ? (
                          <span
                            title={r.recommendation.reason}
                            style={{ color: REC[r.recommendation.kind].color, fontWeight: 700 }}
                          >
                            {REC[r.recommendation.kind].label}
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-faint)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}

const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 600, whiteSpace: "nowrap" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };
