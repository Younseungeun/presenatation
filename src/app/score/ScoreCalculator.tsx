"use client";

import { useMemo, useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import {
  computeDirectionScore,
  computeStabilityScore,
  MIN_MAGNITUDE_PCT,
  STABILITY_TOLERANCE,
} from "@/domain/scoring";
import styles from "./score.module.css";

// 점수 계산기 — "이 플랫폼은 공정하게 채점하는가"에 대한 답을 숫자로 보여준다.
//
// 핵심은 **정산이 쓰는 함수를 그대로 부른다**는 점이다. 화면용으로 공식을 옮겨 적으면
// 언젠가 둘이 갈라지고, 갈라지는 순간 이 화면은 신뢰를 만드는 게 아니라 깨뜨린다.
// domain/scoring.ts의 computeDirectionScore·computeStabilityScore가 유일한 출처다.
//
// 곡선을 함께 그리는 이유: 숫자 한 개는 "그래서 유리한가 불리한가"를 말해주지 못한다.
// 실현 등락을 축으로 점수 전체를 그리면 세 가지가 눈에 보인다 —
//   ① 방향이 반대일 때 잃는 양의 상한이 자기가 신고한 크기로 막혀 있다
//   ② 예측의 절반이 본전선이다
//   ③ 더 크게 맞혀도 상한이 있어, 크게 부르는 것 말고는 증점 경로가 없다

const SWATCH = { dir: "#0b7a66", stab: "#8b95a1", total: "#191f28" } as const;

function fmt(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString()}`;
}

/** 곡선 좌표계 — 실현 등락(가로) × 점수(세로) */
const VIEW = { w: 320, h: 150, padX: 6, padY: 10 } as const;

export function ScoreCalculator() {
  const [assetClass, setAssetClass] = useState<AssetClass>("KR_EQUITY");
  const [up, setUp] = useState(true);
  const [magnitude, setMagnitude] = useState(10);
  const [confidence, setConfidence] = useState(3);
  const [stability, setStability] = useState(3);
  const [realized, setRealized] = useState(8);

  const floor = MIN_MAGNITUDE_PCT[assetClass];
  const direction = up ? "UP" : "DOWN";
  // 크기 하한 미만은 애초에 게시가 막히므로 계산기에서도 같은 하한을 강제한다
  const size = Math.max(magnitude, floor);

  const result = useMemo(() => {
    const d = computeDirectionScore(direction, size, confidence, realized);
    const s = computeStabilityScore(direction, size, stability, realized, floor);
    return { d, s, total: d.score + s.score };
  }, [direction, size, confidence, stability, realized, floor]);

  // 실현 등락 축의 범위 — 예측 크기의 ±2.5배면 손익 구조가 전부 들어온다
  const span = Math.max(size * 2.5, floor * 2.5);

  const curve = useMemo(() => {
    const pts: Array<{ x: number; y: number }> = [];
    for (let i = 0; i <= 120; i++) {
      const r = -span + (2 * span * i) / 120;
      if (r === 0) {
        pts.push({ x: r, y: 0 }); // 실현 0%는 무승부 — 표본 제외
        continue;
      }
      const y =
        computeDirectionScore(direction, size, confidence, r).score +
        computeStabilityScore(direction, size, stability, r, floor).score;
      pts.push({ x: r, y });
    }
    return pts;
  }, [direction, size, confidence, stability, floor, span]);

  const yMax = Math.max(...curve.map((p) => Math.abs(p.y)), 1);
  const toX = (r: number) =>
    VIEW.padX + ((r + span) / (2 * span)) * (VIEW.w - VIEW.padX * 2);
  const toY = (v: number) =>
    VIEW.h / 2 - (v / yMax) * (VIEW.h / 2 - VIEW.padY);

  const path = curve
    .map((p, i) => `${i === 0 ? "M" : "L"}${toX(p.x).toFixed(1)},${toY(p.y).toFixed(1)}`)
    .join(" ");

  const breakEven = (up ? size : -size) / 2; // 본전선 = 예측의 절반

  return (
    <div className={styles.calc}>
      <div className={styles.controls}>
        <div className={styles.field}>
          <span className={styles.label}>자산군</span>
          <div className={styles.segment}>
            {ASSET_CLASSES.map((a) => (
              <button
                key={a}
                type="button"
                className={`${styles.segBtn} ${a === assetClass ? styles.segOn : ""}`}
                onClick={() => setAssetClass(a)}
              >
                {ASSET_CLASS_LABEL[a]}
              </button>
            ))}
          </div>
          <span className={styles.hint}>크기 하한 {floor}% · 안정성 정규화 바닥도 같은 값</span>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>방향</span>
          <div className={styles.segment}>
            <button
              type="button"
              className={`${styles.segBtn} ${up ? styles.segOn : ""}`}
              onClick={() => setUp(true)}
            >
              ▲ 상승
            </button>
            <button
              type="button"
              className={`${styles.segBtn} ${!up ? styles.segOn : ""}`}
              onClick={() => setUp(false)}
            >
              ▼ 하락
            </button>
          </div>
        </div>

        <Slider
          label="예측 크기"
          value={size}
          min={floor}
          max={60}
          step={1}
          suffix="%"
          onChange={setMagnitude}
          hint="내가 주장하는 등락 폭. 이 값이 곧 걸고 딸 수 있는 상한이다"
        />
        <Slider
          label="신뢰도"
          value={confidence}
          min={1}
          max={10}
          step={1}
          onChange={setConfidence}
          hint={`증폭 배율 — 맞으면 ×${confidence}, 틀리면 ×${(confidence * (confidence + 1)) / 2}`}
        />
        <Slider
          label="안정성"
          value={stability}
          min={1}
          max={10}
          step={1}
          onChange={setStability}
          hint={
            stability <= 1
              ? "1은 불참 — 안정성 점수가 아예 발동하지 않는다"
              : `정밀도 배팅 ${stability - 1} — 예측에서 ${Math.round(STABILITY_TOLERANCE * 100)}% 넘게 빗나가면 벌점 구간`
          }
        />
        <Slider
          label="실제 실현 등락"
          value={realized}
          min={-Math.round(span)}
          max={Math.round(span)}
          step={1}
          suffix="%"
          onChange={setRealized}
          hint="시한이 왔을 때 시장이 실제로 움직인 값"
          emphasis
        />
      </div>

      {/* 결과 — 두 성분을 따로 보여야 "왜 이 점수인지"가 읽힌다 */}
      <div className={styles.result}>
        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>이 카드의 점수</span>
          <strong
            className={styles.total}
            style={{ color: result.total >= 0 ? "var(--pos)" : "var(--neg)" }}
          >
            {fmt(result.total)}
          </strong>
        </div>
        <div className={styles.parts}>
          <div className={styles.part}>
            <span className={styles.partKey}>
              <i style={{ background: SWATCH.dir }} />
              방향·크기
            </span>
            <span className={styles.partVal}>{fmt(result.d.score)}</span>
            <span className={styles.partNote}>
              개선 거리 {result.d.distance >= 0 ? "+" : "−"}
              {Math.abs(result.d.distance).toFixed(1)}%p
            </span>
          </div>
          <div className={styles.part}>
            <span className={styles.partKey}>
              <i style={{ background: SWATCH.stab }} />
              안정성
            </span>
            <span className={styles.partVal}>{fmt(result.s.score)}</span>
            <span className={styles.partNote}>
              {stability <= 1
                ? "불참"
                : `정규화 오차 ${result.s.normalizedError.toFixed(2)}`}
            </span>
          </div>
        </div>

        {/* 점수 곡선 — 실현 등락 전 구간에서 얼마를 따고 잃는지 */}
        <figure className={styles.chartWrap}>
          <svg
            className={styles.chart}
            viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`실현 등락에 따른 점수 곡선. 현재 설정에서 실현 ${realized}%면 ${Math.round(result.total)}점`}
          >
            {/* 0점 축 */}
            <line
              x1={VIEW.padX}
              x2={VIEW.w - VIEW.padX}
              y1={VIEW.h / 2}
              y2={VIEW.h / 2}
              stroke="var(--border)"
              strokeWidth="1"
            />
            {/* 본전선 — 예측의 절반 */}
            <line
              x1={toX(breakEven)}
              x2={toX(breakEven)}
              y1={VIEW.padY}
              y2={VIEW.h - VIEW.padY}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {/* 목표선 */}
            <line
              x1={toX(up ? size : -size)}
              x2={toX(up ? size : -size)}
              y1={VIEW.padY}
              y2={VIEW.h - VIEW.padY}
              stroke={SWATCH.dir}
              strokeWidth="1"
              strokeDasharray="2 4"
              opacity="0.6"
            />
            <path
              d={path}
              fill="none"
              stroke={SWATCH.total}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
            {/* 현재 위치 */}
            <circle
              cx={toX(realized)}
              cy={toY(result.total)}
              r="4"
              fill={result.total >= 0 ? "var(--pos)" : "var(--neg)"}
              stroke="var(--bg)"
              strokeWidth="2"
            />
          </svg>
          <figcaption className={styles.chartLegend}>
            <span>← 실현 −{Math.round(span)}%</span>
            <span className={styles.legendMid}>
              점선 = 본전선({breakEven.toFixed(1)}%) · 점목표선 = 예측({up ? "+" : "−"}
              {size}%)
            </span>
            <span>+{Math.round(span)}% →</span>
          </figcaption>
        </figure>
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  hint,
  emphasis,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  hint: string;
  emphasis?: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>
        {label}
        <strong className={emphasis ? styles.valueOn : styles.value}>
          {value}
          {suffix}
        </strong>
      </span>
      <input
        className={styles.range}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className={styles.hint}>{hint}</span>
    </div>
  );
}
