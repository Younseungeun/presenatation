import { RISK_CATEGORY_LABEL, type RiskCategory } from "@/domain/compliance";
import type {
  ApprovedElapsedCoverage,
  DecisionSpeedRow,
} from "@/server/decisionSpeedService";
import { SecHead } from "../Why";
import a from "../admin.module.css";

/**
 * 판단 시간을 실제로 재기 시작한 날. 집계 창(7일)이 이 날짜를 넘어설 때까지는
 * "시간 없음"의 대부분이 **측정 도입 전 승인**이라 결함이 아니다 — 그 사실을 한 줄로
 * 덧붙이되, 창이 지나가면 저절로 사라진다. 사람이 지우는 것을 기억해야 하는 문구는
 * 언젠가 낡은 채로 남는다.
 */
const MEASURE_START = Date.UTC(2026, 7, 22);
const MEASURE_START_LABEL = "8월 22일";
const WINDOW_DAYS = 7;

/**
 * **판단 소요 시간** (26차 CC-1 반증 조건 — 피로도 함정 감지).
 *
 * 라이브 학생을 유지하는 대가는 운영자가 오탐을 흡수하는 것이다. 그런데 오탐 승인과
 * 정상 승인이 화면에서 **같은 클릭**이라, 결과 데이터로는 "읽고 승인했다"와
 * "지쳐서 눌렀다"가 구별되지 않는다. 갈라 주는 신호가 시간 하나뿐이다.
 *
 * ── 읽는 법이 한쪽으로만 열려 있다 ──────────────────────────────
 * **짧은 것이 신호이고, 긴 것은 신중이다.** 그래서 이 표는 오래 걸린 유형을 문제로
 * 그리지 않는다 — 위쪽으로 부푼 값(탭을 열어 둔 채 자리를 비움)이 지표를 망치지
 * 않는 이유도 같다. 아래쪽만 본다.
 *
 * ── 표본이 적으면 판정하지 않는다 ───────────────────────────────
 * 한두 건의 빠른 클릭은 피로가 아니라 우연이다. 서버가 5건 미만은 `fatigueSuspect`
 * 를 세우지 않으므로 화면도 그 판단을 존중하고, 대신 **표본 수를 함께 적는다** —
 * "2건 중앙값 3초"를 근거로 사람을 의심하게 두면 안 된다.
 */
export function DecisionSpeedPanel({
  rows,
  coverage,
}: {
  rows: DecisionSpeedRow[];
  coverage: ApprovedElapsedCoverage;
}) {
  const missing = coverage.approvedWithoutElapsed;

  // 잰 것이 하나도 없으면 그리지 않는다 — 빈 표는 정보가 아니라 장식이고,
  // 매일 보이면 곧 안 보이게 된다 (학생 순이익 패널과 같은 규칙).
  // **다만 못 잰 건이 있으면 그린다** — 표가 비어 있는데 승인은 있었다는 것이
  // 이 패널이 낼 수 있는 가장 큰 소리다. 거기서 침묵하면 "아무 일도 없었다"로 읽힌다
  if (rows.length === 0 && missing === 0) return null;

  const suspects = rows.filter((r) => r.fatigueSuspect);
  // 집계 창이 아직 측정 시작일을 물고 있는가
  const windowStart = Date.now() - WINDOW_DAYS * 86_400_000;
  const spansPreMeasure = windowStart < MEASURE_START;

  return (
    <>
      <SecHead
        title={
          <>
            판단 소요 시간{" "}
            <span className={`${a.n} ${suspects.length === 0 ? a.nCalm : ""}`}>
              {suspects.length}
            </span>
          </>
        }
      >
        건을 <b>펼친 시각부터 판정 버튼까지</b> 걸린 시간을 유형별로 모았습니다 (최근 7일).
        읽는 방향은 <b>한쪽뿐입니다 — 짧은 것이 신호이고 긴 것은 신중입니다.</b> 어떤
        유형만 유독 빠르다면 그 소견은 읽히지 않고 승인되고 있다는 뜻입니다. 오탐 승인과
        정상 승인은 화면에서 같은 클릭이라, 이 시간 말고는 둘을 가를 방법이 없습니다.
      </SecHead>

      <div className={a.card}>
        {rows.map((r) => (
          <div key={r.category} className={a.row} style={{ padding: "6px 0" }}>
            <span
              style={{
                fontWeight: r.fatigueSuspect ? 700 : 400,
                color: r.fatigueSuspect ? "#c4303b" : undefined,
              }}
            >
              {RISK_CATEGORY_LABEL[r.category as RiskCategory] ?? r.category}
            </span>
            <span className={a.rowTags}>
              {/* 표본 수를 값 옆에 붙인다 — 중앙값만 있으면 2건과 40건이 같은 무게로 읽힌다 */}
              <span style={{ color: "var(--text-faint)", fontSize: 12.5 }}>{r.n}건</span>
              <span
                className={`${a.chip} ${r.fatigueSuspect ? a.chipNeg : ""}`}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {readable(r.medianMs)}
              </span>
            </span>
          </div>
        ))}

        {suspects.length > 0 ? (
          <div className={`${a.note} ${a.noteNeg}`}>
            <b>
              {suspects
                .map((s) => RISK_CATEGORY_LABEL[s.category as RiskCategory] ?? s.category)
                .join(" · ")}
            </b>{" "}
            의 판단이 다른 유형의 <b>절반 밑</b>입니다. 이 소견들이 읽히지 않고 있을 수
            있습니다 — 오탐이 잦은 유형이라면 그 규칙·프롬프트를 고치는 것이 답이지,
            빠르게 넘기는 것이 답이 아닙니다.
          </div>
        ) : rows.length > 0 ? (
          <div className={a.note}>
            유독 빠른 유형이 없습니다. 표본이 5건 미만인 유형은 판정하지 않습니다 — 한두
            건의 빠른 클릭은 피로가 아니라 우연입니다.
          </div>
        ) : null}

        {/* **분모에서 사라진 건을 적는다.** 위 표는 시간이 있는 건만 모으므로, 시간이
            없는 승인은 느린 쪽에도 빠른 쪽에도 안 잡히고 그냥 없는 일이 된다. 학습의
            3초 필터도 같은 건들을 못 본다 — 비율이 높으면 위 표가 재고 있는 것이
            승인 전체가 아니라 그 일부다 */}
        {missing > 0 ? (
          <div className={a.note}>
            최근 {WINDOW_DAYS}일 승인 <b>{coverage.approvedTotal}건 중 {missing}건</b>에
            판단 시간이 없습니다 — 위 표의 분모에서도 빠져 있고, 학습의 3초 필터도 이
            건들은 보지 못합니다.
            {spansPreMeasure ? (
              <>
                {" "}
                측정은 <b>{MEASURE_START_LABEL}</b>에 시작해, 그 전 승인이 아직 이 창에
                남아 있습니다. 창이 지나면 이 줄은 사라집니다.
              </>
            ) : (
              <> 큐에서 펼친 카드가 아닌 경로로 승인됐거나, 시간이 실려 오지 않았습니다.</>
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

/**
 * 사람이 읽는 시간. 초 단위 아래로는 내려가지 않는다 — 밀리초를 그리면 정밀해
 * 보이지만 이 지표가 답하는 질문("읽었나")에는 그 자릿수가 의미가 없다.
 */
function readable(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return rest ? `${min}분 ${rest}초` : `${min}분`;
  return `${Math.floor(min / 60)}시간 ${min % 60}분`;
}
