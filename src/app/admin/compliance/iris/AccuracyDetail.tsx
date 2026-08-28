import type { AccuracySummary, BreakdownStat, ElapsedGap } from "@/domain/screeningAccuracy";
import { violationLabel, type RiskCategory } from "@/domain/compliance";
import { SecHead } from "../../Why";
import a from "../../admin.module.css";

/**
 * **검수 정확도 상세** — 계기판이 비율로 접어 둔 것을 건수로 펴는 자리
 * (2026-08-23 창업자 지시).
 *
 * 계기판은 매일 곁눈질하는 화면이라 `정탐 25% · 오탐 50% · 미탐 0건` 세 조각만 남겼다.
 * **비율은 표본이 작을 때 거짓말한다** — 4건 중 1건도 25%이고 400건 중 100건도 25%다.
 * 되짚으러 온 사람이 먼저 묻는 것은 "몇 건이냐"이고, 그 답이 여기 있다.
 *
 * ── 넷을 한 줄씩, 유형까지 그 자리에서 (창업자 지시) ────────────
 * `오탐 2건` 만으로는 **무엇을 잘못 잡았는지** 모른다. 유형을 따로 아래에 모아 두면
 * 눈이 두 번 오가야 하므로, 건수 바로 옆에 붙인다. 설명 문장("보류했는데 승인했다")은
 * 걷었다 — 넷의 뜻은 위 안내에 이미 있고, 매번 되풀이하면 숫자가 문장에 묻힌다.
 *
 * ⚠ **단위가 둘이다.** 왼쪽 건수는 **검수 건**이고 괄호 안은 **소견 개수**다 —
 * 한 건이 소견을 여럿 달 수 있어 합이 어긋날 수 있다. 화면에 문장으로 적으면 숫자보다
 * 주석이 길어지므로 `title` 로만 밝힌다.
 *
 * ── 경미에는 유형이 없다 ───────────────────────────────────────
 * 유형별 집계는 소견을 `인정 / 오탐 / 미탐` 셋으로만 가른다. 경미는 "인정하되 심각도가
 * 과했다"라 인정 쪽에 섞여 들어가 따로 셀 수가 없다. **없는 것을 지어내지 않고**
 * 건수만 적는다.
 */

const UNIT_HINT = "괄호 안은 소견 개수입니다 — 한 건이 소견을 여럿 달 수 있어 왼쪽 건수와 다를 수 있습니다.";

function types(list: BreakdownStat<RiskCategory>[], pick: (b: BreakdownStat<RiskCategory>) => number) {
  const hit = list.filter((c) => pick(c) > 0);
  if (hit.length === 0) return null;
  // 커스텀 유형(운영자 정의)이면 라벨이 곧 key 라 그대로 뜬다 (violationLabel 폴백)
  return hit.map((c) => `${violationLabel(c.key)} ${pick(c)}건`).join(" · ");
}

function pct(v: number | null) {
  return v === null ? "—" : `${Math.round(v * 100)}%`;
}

/**
 * **판단 시간이 없는 건을 그 줄 옆에 적는다** (2026-08-24 창업자 지시).
 *
 * 표 아래에 뭉쳐 적으면 "어느 줄이 얼마나 비어 있나"를 알 수 없다. 판단 시간이 없는
 * 건은 피로도 표의 분모에서도 빠지고 학습의 3초 필터도 못 보므로, **그 줄이 재고 있는
 * 것이 전부가 아니라는 사실**은 그 줄 옆에서 말해야 한다.
 *
 * 사유마다 칩을 따로 낸다 — 둘은 처방이 정반대다:
 * · `측정 전` = 잴 장치가 없던 때. 나이지 결함이 아니고 저절로 사라진다 → 무채색
 * · `큐 밖`   = 측정이 도는데 안 실려 왔다 → 붉은색. **다만 미탐은 예외다**:
 *   강제 철회는 애초에 큐에서 펼치는 경로가 아니라 시간이 없는 것이 정상이다
 *   (`/api/admin/compliance` 규약 — 큐 밖 경로는 보내지 않는다). 거기에 붉은 칩을
 *   달면 고칠 수 없는 것을 매일 빨갛게 그리는 셈이고, 그러면 진짜 신호가 묻힌다.
 */
function GapChips({ gap, offIsNormal }: { gap: ElapsedGap; offIsNormal: boolean }) {
  const chips: { key: string; text: string; bad: boolean; hint: string }[] = [];
  if (gap.beforeMeasureStart > 0)
    chips.push({
      key: "pre",
      text: `측정 전 ${gap.beforeMeasureStart}`,
      bad: false,
      hint: "판단 시간을 재기 전에 내려진 판정입니다. 잴 장치가 없었으므로 고칠 것이 없고, 오래된 건이 밀려나면 사라집니다.",
    });
  if (gap.offQueue > 0)
    chips.push({
      key: "off",
      text: `큐 밖 ${gap.offQueue}`,
      bad: !offIsNormal,
      hint: offIsNormal
        ? "강제 철회는 큐에서 펼치는 경로가 아니라 판단 시간이 없는 것이 정상입니다."
        : "측정이 도는 중인데 시간이 실려 오지 않았습니다 — 큐에서 펼친 카드가 아닌 경로로 판정됐다는 뜻입니다.",
    });
  if (chips.length === 0) return null;
  return (
    <>
      {chips.map((c) => (
        <span
          key={c.key}
          className={`${a.chip} ${c.bad ? a.chipNeg : ""}`}
          title={`판단 시간 없음 — ${c.hint}`}
        >
          {c.text}
        </span>
      ))}
    </>
  );
}

function Line({
  label,
  count,
  detail,
  tone,
  gap,
  offIsNormal = false,
}: {
  label: string;
  count: number;
  detail: string | null;
  tone?: string;
  gap: ElapsedGap;
  offIsNormal?: boolean;
}) {
  return (
    <div className={a.row} style={{ padding: "7px 0", alignItems: "baseline" }}>
      <span style={{ minWidth: 44, fontWeight: 700 }}>{label}</span>
      <b
        style={{
          fontVariantNumeric: "tabular-nums",
          fontSize: 15,
          color: count > 0 ? tone : "var(--text-faint)",
        }}
      >
        {count}건
      </b>
      {/* **유형이 없어도 자리는 남긴다** (2026-08-23 창업자 지시).
          `a.row` 가 양끝 정렬이라 이 칸이 없으면 건수가 오른쪽 끝으로 밀려, 유형이 있는
          줄과 없는 줄에서 숫자가 다른 자리에 선다. 넷을 세로로 훑을 때 **숫자가 한 줄로
          서 있어야** 크기 비교가 되므로, 빈 칸이 남은 폭을 먹게 둔다 */}
      <span
        style={{ flex: 1, fontSize: 12.5, color: "var(--text-muted)" }}
        title={detail ? UNIT_HINT : undefined}
      >
        {detail ? `(${detail})` : ""}
      </span>
      {/* 칩은 **유형 문구 오른쪽**에 선다 (창업자 지시) — 유형이 "무엇을 잡았나"라면
          칩은 "그 숫자를 얼마나 믿을 수 있나"라, 읽는 순서가 그 순서다 */}
      <GapChips gap={gap} offIsNormal={offIsNormal} />
    </div>
  );
}

export function AccuracyDetail({ summary }: { summary: AccuracySummary }) {
  if (summary.labeled === 0) {
    return (
      <>
        <SecHead title="검수 정확도">
          <span>
            운영자의 결정이 곧 <b>정답 라벨</b>입니다 — 승인·반려·철회를 내리면 그것이
            검수의 채점표가 됩니다.
          </span>
        </SecHead>
        <div className={a.note}>
          아직 판정 표본이 없습니다. 보류 건을 승인하거나 반려하면 여기부터 쌓입니다.
        </div>
      </>
    );
  }

  const byCat = summary.byCategory;

  return (
    <>
      <SecHead title="검수 정확도">
        <span>
          <b>운영자의 결정이 곧 정답 라벨입니다.</b> 보류된 걸 반려하면 정탐, 승인하면
          오탐, 승인하며 &lsquo;지적은 타당&rsquo;을 표시하면 경미, 통과시킨 걸 철회하면
          미탐입니다 — 따로 채점하는 절차가 없습니다.
        </span>{" "}
        <span>
          분모는 <b>보류된 건</b>뿐입니다(소견이 붙어 게시가 멈춘 것). 그냥 통과한
          리포트는 세지 않습니다. 미탐에는 분모가 없어 비율을 적지 않습니다.
        </span>{" "}
        <span>
          검수 실패(장애)로 보류된 건과 시한 경과 자동 만료는 표본에서 뺍니다 — 판단
          자체가 없었거나, 시간이 만든 결과지 사람의 판단이 아니기 때문입니다.
        </span>
      </SecHead>

      <div className={a.card}>
        <Line
          label="정탐"
          count={summary.truePositive}
          detail={types(byCat, (c) => c.confirmed)}
          tone="#0e8a71"
          gap={summary.noElapsed.truePositive}
        />
        <Line
          label="오탐"
          count={summary.falsePositive}
          detail={types(byCat, (c) => c.falsePositive)}
          tone="#b45309"
          gap={summary.noElapsed.falsePositive}
        />
        {/* 경미도 소견이 붙어 보류된 건이라 **왜 막았는지가 있다.** 예전에는 집계기가
            인정 쪽에 섞어 담아 유형을 못 봤는데, 그건 셀 수 없어서가 아니라 나눠 놓지
            않아서였다(2026-08-23 창업자 지적으로 집계기를 나눔) */}
        <Line
          label="경미"
          count={summary.minor}
          detail={types(byCat, (c) => c.minor)}
          gap={summary.noElapsed.minor}
        />
        <Line
          label="미탐"
          count={summary.falseNegative}
          detail={types(byCat, (c) => c.missed)}
          tone="#c4303b"
          gap={summary.noElapsed.falseNegative}
          /* 미탐 = 강제 철회. 큐에서 펼치는 경로가 아니라 시간이 없는 것이 정상이다 */
          offIsNormal
        />

        <div className={a.meta}>
          <span>표본 {summary.labeled}건</span>
          <span>보류 {summary.held}건</span>
          <span>정탐률 {pct(summary.precision)}</span>
          <span>오탐률 {pct(summary.falsePositiveRate)}</span>
        </div>

        {/* **출처는 맨 아래** (창업자 지시) — 위가 "무엇을 틀렸나"라면 이 줄은
            "어디를 고치나"다. 판단이 끝난 뒤에 읽는 값이라 자리도 끝이다 */}
        {summary.bySource.some((s) => s.falsePositive > 0) && (
          <div className={a.note}>
            출처별{" "}
            {summary.bySource
              .filter((s) => s.falsePositive > 0)
              .map(
                (s) =>
                  `${s.key === "rule" ? "규칙" : s.key === "ai" ? "AI" : s.key === "student" ? "IRIS" : s.key === "learned" ? "학습 표현" : "미상"} ${s.falsePositive}건`,
              )
              .join(" · ")}
            . <b>고칠 곳이 다릅니다</b> — 규칙 오탐은 정규식을, AI 오탐은 프롬프트를,
            IRIS 오탐은 재학습 자료를 봐야 합니다.
          </div>
        )}
      </div>
    </>
  );
}
