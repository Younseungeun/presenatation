import type { DetectionLadderRow } from "@/server/detectionLadderService";
import { LADDER_THRESHOLDS, type LadderRecommendationKind } from "@/domain/detectionLadder";
import { SecHead } from "../Why";
import a from "../admin.module.css";
import { ItemPackButton } from "./ItemPackButton";

// 검출 항목 관리 표 — 승격/강등 사다리 (2026-08-28). 재학습 논의 자료 상세 화면 안에 산다:
// 근거 데이터가 같으므로(운영자 판정) 한 화면에서 사건별(질문지)과 규칙별(이 표)을 함께 본다.
// **추천만·읽기 전용** — 실제 층 이동은 각각 게이트를 타는 사람의 일이다.

const LAYER_LABEL: Record<DetectionLadderRow["layer"], string> = {
  PHRASE: "학습표현",
  RULE_WARN: "규칙 WARN",
  RULE_BLOCK: "규칙 BLOCK",
  IRIS: "IRIS",
};

// 축 내 이동(승격 ▲)과 축 간 이동(졸업 ↗ / 졸업 강등 ↙)을 화살표로 가른다 (2026-08-31 어휘).
// 규칙→IRIS 위임도 하강(▼)이 아니라 관할 이전(↗ 졸업 계열)이다 — 형태 매칭이 못 가르는
// 문맥은 의미 추론의 몫이라, 실패가 아니라 "어느 방식이 효과적인가"의 답이 바뀐 것이다
const REC: Record<LadderRecommendationKind, { label: string; color: string }> = {
  PROMOTE_RULE: { label: "▲ 규칙 WARN 승격", color: "#0e6f5c" },
  PROMOTE_BLOCK: { label: "▲ BLOCK 승격 자격", color: "#0e6f5c" },
  GRADUATE_IRIS: { label: "↗ IRIS 졸업 (실적)", color: "#2a6fb0" },
  DELEGATE_IRIS: { label: "↗ IRIS 졸업 (문맥 위임)", color: "#2a6fb0" },
  // UNGRADUATE 자동 추천은 졸업 강등의 좁은 지름길(졸업했던 사전 항목의 복귀)만 다룬다 —
  // 본선(신규 코드화 설계)은 재학습 질문지의 관할 재검토 논의 몫이라 표에 안 뜬다
  UNGRADUATE: { label: "↙ 졸업 강등 (복귀 후보)", color: "#bd4242" },
};

const th: React.CSSProperties = { padding: "8px 10px", fontWeight: 600, whiteSpace: "nowrap" };
const thNum: React.CSSProperties = { ...th, textAlign: "right" };
const td: React.CSSProperties = { padding: "8px 10px", verticalAlign: "top" };
const tdNum: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export function DetectionLadderTable({ rows }: { rows: DetectionLadderRow[] }) {
  const withRec = rows.filter((r) => r.recommendation);

  return (
    <section style={{ marginTop: 8 }}>
      <SecHead title="검출 항목 관리 — 승격·졸업 사다리">
        같은 판정 데이터를 <b>규칙·표현별로 합쳐</b> 봅니다(위 질문지는 사건별). 어느 항목이
        어느 관문 조건에 닿았는지 <b>추천만</b> 냅니다 — 실제 층 이동은 각각 게이트를 타는
        사람의 일입니다. ▲승격은 축 안(사전→WARN→BLOCK)에서 <b>문맥 조건을 코드로 적을 수
        있을 때</b>, ↗졸업·↙졸업 강등은 <b>형태 매칭 ↔ 의미 추론(IRIS) 중 어느 쪽이
        효과적인가</b>로 정합니다. 문턱 숫자(걸림 {LADDER_THRESHOLDS.phraseMinMatched}·형태 ≤
        {LADDER_THRESHOLDS.formMaxSurfaces}종·BLOCK {LADDER_THRESHOLDS.blockMinMatched}건·복귀
        미탐-정탐 {LADDER_THRESHOLDS.ungraduateMinMissTruePos}건 등)는 <b>전부 초안</b>이라 운영
        표본이 쌓이면 재보정합니다. 축 간 추천은 양방향 모두 <b>상호 실증</b>입니다 — 졸업은
        &ldquo;IRIS가 이미 잡는다(중복)&rdquo;, 복귀는 &ldquo;IRIS가 놓친 확정 위반을 옛 항목이
        잡는다(구멍)&rdquo;의 영수증이 있을 때만 뜹니다 — 그 영수증의 현재 수가{" "}
        <b>상호 실증</b> 열입니다. IRIS 층 행의 정탐/오탐은 <b>그림자
        값</b>입니다 — 관찰이 소견을 내지 않았으므로, 그림자가 잡은 문서를 사람이 어떻게
        판정했는지의 사후 대조입니다.
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
                  <th style={th}>상호 실증</th>
                  <th style={th}>추천 이동</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                    <td style={{ ...td, maxWidth: 240, wordBreak: "break-word" }}>
                      {r.label}
                      {/* 항목별 질문지 — 학습표현·규칙 WARN 만 (BLOCK 은 사람 판정이 안 붙고
                          IRIS 는 항목 단위가 아니다). 이 항목이 잡은 문장 전부를 모아
                          variation 공식화를 묻는 재학습 논의 자료 (2026-09-01) */}
                      {(r.layer === "PHRASE" || r.layer === "RULE_WARN") && (
                        <ItemPackButton itemId={r.id} />
                      )}
                    </td>
                    <td style={td}>{LAYER_LABEL[r.layer]}</td>
                    <td style={tdNum}>{r.matched}</td>
                    <td style={tdNum}>{r.truePos}</td>
                    <td style={{ ...tdNum, color: r.falsePos > 0 ? "#bd4242" : undefined }}>
                      {r.falsePos}
                    </td>
                    <td style={{ ...td, color: "var(--text-faint)" }}>
                      {/* 형태는 형태만 말한다 — IRIS 행의 미탐은 상호 실증 열로 옮겼다
                          (한 칸에 형태·미탐을 겹치면 눈이 매번 다시 해석해야 한다).
                          규칙 WARN 도 출현형이 쌓이면 형태를 보인다 (12차 C-2) — 도입 전 기록뿐이면 — */}
                      {(r.layer === "PHRASE" || r.layer === "IRIS" || r.layer === "RULE_WARN") && r.distinctSurfaces != null
                        ? `${r.distinctSurfaces}종·최빈 ${Math.round((r.topSurfaceShare ?? 0) * 100)}%`
                        : "—"}
                    </td>
                    <td style={{ ...td, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                      {r.layer === "PHRASE" ? (
                        // 졸업의 실증: 사전이 걸린 확정 건에서 IRIS 도 같은 유형을 냈는가.
                        // 미동반 > 0 이면 사전이 아직 하중을 지고 있다 — 졸업 추천이 서지 않는다
                        // 미동반은 위험 신호가 아니다 — 사전이 켜져 있어 아무것도 새지
                        // 않았고, 다만 졸업이 아직 이르다는 뜻이라 색을 입히지 않는다
                        <span title="사전 소견이 걸린 확정 건에서 IRIS(라이브 또는 그림자)가 같은 유형을 함께 냈는가 — 졸업(중복 실증)의 재료. 미동반이 있으면 사전이 아직 하중을 진다">
                          IRIS 동반 {r.studentCoDetected ?? 0}·미동반 {r.studentMissed ?? 0}
                        </span>
                      ) : r.layer === "IRIS" ? (
                        // 복귀의 실증: IRIS 가 놓친 것 중 사람이 위반으로 확정한 부분집합.
                        // 미탐 총수는 재학습 신호일 뿐 이동 사유가 아니다 (2026-08-31 확정)
                        <span title="그림자 관찰의 미탐 중 사람이 위반으로 확정한 건(미탐-정탐) — 복귀(구멍 실증)의 트리거. 미탐 총수는 재학습 신호">
                          미탐 {r.studentMissCount ?? 0}·그중 확정{" "}
                          <b style={{ color: (r.missTruePos ?? 0) > 0 ? "#bd4242" : undefined }}>
                            {r.missTruePos ?? 0}
                          </b>
                        </span>
                      ) : (
                        "—"
                      )}
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
