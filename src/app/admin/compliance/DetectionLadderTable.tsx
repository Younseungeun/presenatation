import type { DetectionLadderRow } from "@/server/detectionLadderService";
import { LADDER_THRESHOLDS, type LadderRecommendationKind } from "@/domain/detectionLadder";
import { SecHead } from "../Why";
import a from "../admin.module.css";

// 검출 항목 관리 표 — 승격/강등 사다리 (2026-08-28). 재학습 논의 자료 상세 화면 안에 산다:
// 근거 데이터가 같으므로(운영자 판정) 한 화면에서 사건별(질문지)과 규칙별(이 표)을 함께 본다.
// **추천만·읽기 전용** — 실제 층 이동은 각각 게이트를 타는 사람의 일이다.

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

const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 600, whiteSpace: "nowrap" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export function DetectionLadderTable({ rows }: { rows: DetectionLadderRow[] }) {
  const withRec = rows.filter((r) => r.recommendation);

  return (
    <section style={{ marginTop: 8 }}>
      <SecHead title="검출 항목 관리 — 승격·강등 사다리">
        같은 판정 데이터를 <b>규칙·표현별로 합쳐</b> 봅니다(위 질문지는 사건별). 어느 항목이
        어느 관문 조건에 닿았는지 <b>추천만</b> 냅니다 — 실제 층 이동은 각각 게이트를 타는
        사람의 일입니다. 문턱 숫자(걸림 {LADDER_THRESHOLDS.phraseMinMatched}·형태 ≤
        {LADDER_THRESHOLDS.formMaxSurfaces}종·BLOCK {LADDER_THRESHOLDS.blockMinMatched}건 등)는{" "}
        <b>전부 초안</b>이라 운영 표본이 쌓이면 재보정합니다.
      </SecHead>

      {rows.length === 0 ? (
        <div className={a.empty}>
          아직 집계할 판정 데이터가 없습니다 — 운영자 판정이 쌓이면 항목이 뜹니다.
        </div>
      ) : (
        <>
          {withRec.length > 0 && (
            <div className={a.note}>
              추천 이동이 있는 항목 <b>{withRec.length}건</b>.
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
                    <td style={{ ...td, maxWidth: 240, wordBreak: "break-word" }}>{r.label}</td>
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
    </section>
  );
}
