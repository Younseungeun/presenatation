"use client";

import { useMemo, useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import {
  computeReachScore,
  DAILY_SIGMA,
  honestConfidence,
  lossAmplifier,
  MIN_MAGNITUDE_PCT,
  noSkillTouchProbability,
  winAmplifier,
} from "@/domain/scoring";
import { cardStabilityLevel } from "@/domain/stability";
import styles from "./score.module.css";

// 점수 계산기 v4 — "이 플랫폼은 공정하게 채점하는가"에 대한 답을 숫자로 보여준다.
//
// 핵심은 **정산이 쓰는 함수를 그대로 부른다**는 점이다. 화면용으로 공식을 옮겨 적으면
// 언젠가 둘이 갈라지고, 갈라지는 순간 이 화면은 신뢰를 만드는 게 아니라 깨뜨린다.
// domain/scoring.ts의 computeReachScore·noSkillTouchProbability가 유일한 출처다.
//
// v4는 이항 배팅이라 곡선 대신 **배당표**를 보여준다. 네 가지가 눈에 보이게:
//   ① 아무 정보 없이 찍어도 닿는 확률(p₀)이 먼저 공제된다 — 쉬운 목표일수록
//      적중해도 조금 받는다 (공짜 몫을 빼고 지급)
//   ② **종목 변동성도 p₀의 입력이다** — 거친 종목을 고르면 p₀가 커져 보상이 줄어든다.
//      이 축이 없으면 "잘 출렁이는 종목만 골라 얻어걸리기"가 왜 안 통하는지 만져볼 수
//      없다. 그래서 자산군 평균을 기본값으로 두되 **직접 움직일 수 있게** 슬라이더로 낸다
//      (실제 카드는 게시 시점에 잰 그 종목의 60거래일 실현 변동성이 들어간다)
//   ③ 실패 벌점은 게시 순간 확정된다 — 자기 하방을 알고 게시한다
//   ④ 신뢰도를 올릴수록 벌점이 초선형으로 커진다 — 정직한 승산 신고가 최적

function fmt(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString()}`;
}

export function ScoreCalculator() {
  const [assetClass, setAssetClass] = useState<AssetClass>("KR_EQUITY");
  const [up, setUp] = useState(true);
  const [magnitude, setMagnitude] = useState(10);
  const [horizonDays, setHorizonDays] = useState(30);
  const [confidence, setConfidence] = useState(3);
  /** 종목 변동성(하루 %) — 자산군 평균에서 출발하되 사용자가 움직인 뒤에는 그 값을 쓴다 */
  const [sigmaPct, setSigmaPct] = useState<number | null>(null);

  const floor = MIN_MAGNITUDE_PCT[assetClass];
  const direction = up ? ("UP" as const) : ("DOWN" as const);
  // 크기 하한 미만은 애초에 게시가 막히므로 계산기에서도 같은 하한을 강제한다
  const size = Math.max(magnitude, floor);
  // 손대지 않았으면 자산군 평균 — 자산군을 바꾸면 기본값도 따라 바뀐다
  const sigma = sigmaPct ?? DAILY_SIGMA[assetClass] * 100;
  const stability = cardStabilityLevel(sigma / 100);

  const r = useMemo(() => {
    const s = sigma / 100;
    const p0 = noSkillTouchProbability(direction, size, assetClass, horizonDays, s);
    const hit = computeReachScore(direction, size, confidence, assetClass, horizonDays, true, s);
    const miss = computeReachScore(direction, size, confidence, assetClass, horizonDays, false, s);
    // 손익분기 승률: p·win = (1−p)·|loss| 를 푼 값 — 이보다 자주 맞힐 자신이 있어야 이 신뢰도가 남는다
    const w = winAmplifier(confidence) * (1 - p0);
    const l = lossAmplifier(confidence) * p0;
    const breakEven = l / (w + l);
    return { p0, hit: hit.score, miss: miss.score, breakEven };
  }, [direction, size, assetClass, horizonDays, confidence, sigma]);

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

        <div className={styles.field}>
          <span className={styles.label}>
            목표 크기 <b className={styles.value}>{size}%</b>{" "}
            <span className={styles.hint}>(하한 {floor}%)</span>
          </span>
          <input
            className={styles.range}
            type="range"
            min={floor}
            max={assetClass === "CRYPTO" ? 60 : 30}
            step={1}
            value={size}
            onChange={(e) => setMagnitude(Number(e.target.value))}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>
            검증 기간 <b className={styles.value}>{horizonDays}일</b>
          </span>
          <input
            className={styles.range}
            type="range"
            min={1}
            max={180}
            step={1}
            value={horizonDays}
            onChange={(e) => setHorizonDays(Number(e.target.value))}
          />
        </div>

        {/* 종목 변동성 — v4에서 p₀의 입력이다. 이 축을 움직여 보면 "거친 종목을 고르면
            보상이 준다"가 숫자로 보인다 (안정성 별점도 같은 값에서 나온다) */}
        <div className={styles.field}>
          <span className={styles.label}>
            종목 변동성 <b className={styles.value}>하루 {sigma.toFixed(1)}%</b>{" "}
            <span className={styles.hint}>
              (안정성 별 {stability ?? "—"}
              {sigmaPct === null ? " · 자산군 평균" : ""})
            </span>
          </span>
          <input
            className={styles.range}
            type="range"
            min={0.3}
            max={12}
            step={0.1}
            value={sigma}
            onChange={(e) => setSigmaPct(Number(e.target.value))}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>
            신뢰도 <b className={styles.value}>{confidence}</b>
          </span>
          <input
            className={styles.range}
            type="range"
            min={1}
            max={10}
            step={1}
            value={confidence}
            onChange={(e) => setConfidence(Number(e.target.value))}
          />
        </div>
      </div>

      <div className={styles.result}>
        <div className={styles.parts}>
          <div className={styles.part}>
            <span className={styles.partKey}>아무 정보 없이 찍어도 닿는 확률</span>
            <span className={styles.partVal}>{(r.p0 * 100).toFixed(1)}%</span>
            <span className={styles.partNote}>
              무정보 리서처가 이 사양(방향·크기·기간·종목 변동성)으로 우연히 적중할 확률
              — 이 공짜 몫을 빼고 지급합니다. 실제 카드에는 게시 시점에 잰 그 종목의 최근
              60거래일 실현 변동성이 들어갑니다
            </span>
          </div>
          <div className={styles.part}>
            <span className={styles.partKey}>적중하면</span>
            <span className={styles.partVal}>{fmt(r.hit)}점</span>
            <span className={styles.partNote}>
              10 × 크기 × 신뢰도 × (1 − {(r.p0 * 100).toFixed(0)}%) — 쉬운 목표일수록,
              그리고 거친 종목일수록 적게 받습니다
            </span>
          </div>
          <div className={styles.part}>
            <span className={styles.partKey}>실패하면</span>
            <span className={styles.partVal}>{fmt(r.miss)}점</span>
            <span className={styles.partNote}>
              게시하는 순간 확정되는 값입니다 — 얼마나 크게 빗나갔는지는 점수에 들어가지
              않습니다 (주장이 &quot;닿는다/못 닿는다&quot;라서)
            </span>
          </div>
        </div>

        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>이 신뢰도의 손익분기 적중률</span>
          <span className={styles.total}>{(r.breakEven * 100).toFixed(0)}%</span>
        </div>
        <p className={styles.hint}>
          이보다 자주 맞힐 자신이 있을 때만 신뢰도 {confidence}이 남는 장사입니다. 신뢰도를
          올리면 벌점이 초선형(c(c+1)/2)으로 커져서, 자기 승산이 무정보의 몇 배인지
          정직하게 신고하는 것이 수학적 최적입니다
          {r.p0 > 0.02 &&
            ` — 예: 실제 적중 확률이 ${Math.min(
              99,
              Math.round(
                Math.min(0.99, r.p0 * 3) * 100,
              ),
            )}%라면 정직한 신뢰도는 ${honestConfidence(Math.min(0.99, r.p0 * 3), r.p0)}입니다`}
          .
        </p>
      </div>
    </div>
  );
}
