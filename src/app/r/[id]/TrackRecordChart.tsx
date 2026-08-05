import styles from "../../market.module.css";

// 트랙레코드 시각화 — 프로필의 숫자 나열을 3초 만에 읽히는 그림으로.
//  · 누적 수익 곡선: 판정 순서대로 방향 반영 실현 수익률(%)을 균등 비중으로 단순 합산한
//    가상 곡선 (외부 라이브러리 없이 인라인 SVG)
//  · 판정 스트립: 최근 판정을 오래된 순 → 최신 순으로 초록(적중)/빨강(실패) 칸으로
// 값은 전부 판정 기록에서 나온다 — 플랫폼 전망이 아니라 집계된 사실.

export interface TrackPoint {
  judgedAt: Date;
  /** 방향 반영 실현 수익률(%) — 하락 예측 적중이 양수가 되도록 부호 반영 */
  adjReturnPct: number;
  outcome: "HIT" | "MISS";
}

const W = 320;
const H = 96;
const PAD = 8;
const STRIP_MAX = 20;

export function TrackRecordChart({ points }: { points: TrackPoint[] }) {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.judgedAt.getTime() - b.judgedAt.getTime());

  // 누적 합산 곡선 — 0에서 시작
  const cum: number[] = [0];
  for (const p of sorted) cum.push(cum[cum.length - 1] + p.adjReturnPct);
  const final = cum[cum.length - 1];

  const min = Math.min(...cum);
  const max = Math.max(...cum);
  const span = Math.max(max - min, 1); // 전부 0이어도 나눗셈이 안전하게
  const x = (i: number) => PAD + (i / (cum.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + ((max - v) / span) * (H - PAD * 2);
  const path = cum.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const area = `${path} L${x(cum.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;
  const zeroY = y(0);

  const strip = sorted.slice(-STRIP_MAX);

  return (
    <div className={styles.trackChart}>
      {sorted.length >= 2 && (
        <div className={styles.trackCurveWrap}>
          <svg
            className={styles.trackCurve}
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`판정 ${sorted.length}건을 순서대로 따라 샀을 때의 누적 수익 곡선 — 최종 ${final >= 0 ? "+" : ""}${final.toFixed(1)}%`}
          >
            {/* 0% 기준선 */}
            <line
              x1={PAD}
              y1={zeroY}
              x2={W - PAD}
              y2={zeroY}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <path d={area} fill="var(--brand-soft)" opacity="0.65" />
            <path
              d={path}
              fill="none"
              stroke="var(--brand-strong)"
              strokeWidth="2"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <div className={styles.trackCurveMeta}>
            <span>누적 실현 수익 (균등 비중 단순 합산)</span>
            <strong style={{ color: final >= 0 ? "var(--pos)" : "var(--neg)" }}>
              {final >= 0 ? "+" : ""}
              {final.toFixed(1)}%
            </strong>
          </div>
        </div>
      )}

      <div className={styles.trackStrip} aria-label={`최근 판정 ${strip.length}건`}>
        {strip.map((p, i) => (
          <span
            key={i}
            className={styles.trackDot}
            style={{ background: p.outcome === "HIT" ? "var(--pos)" : "var(--neg)" }}
            title={`${new Date(p.judgedAt).toLocaleDateString("ko-KR")} · ${
              p.outcome === "HIT" ? "적중" : "실패"
            } ${p.adjReturnPct >= 0 ? "+" : ""}${p.adjReturnPct.toFixed(1)}%`}
          />
        ))}
        <span className={styles.trackStripLabel}>← 과거 · 최근 →</span>
      </div>
    </div>
  );
}
