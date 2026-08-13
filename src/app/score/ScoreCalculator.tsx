"use client";

import { useMemo, useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import {
  computeReachScore,
  DAILY_SIGMA,
  honestConfidence,

  CONFIDENCE_RANGE,
  minMagnitudePct,
  noSkillTouchProbability,

} from "@/domain/scoring";
import { cardStabilityLevel } from "@/domain/stability";
import styles from "./score.module.css";

// 점수 계산기 v5 — "이 플랫폼은 공정하게 채점하는가"에 대한 답을 숫자로 보여준다.
//
// 핵심은 **정산이 쓰는 함수를 그대로 부른다**는 점이다. 화면용으로 공식을 옮겨 적으면
// 언젠가 둘이 갈라지고, 갈라지는 순간 이 화면은 신뢰를 만드는 게 아니라 깨뜨린다.
// domain/scoring.ts의 computeReachScore·noSkillTouchProbability가 유일한 출처다.
//
// v5는 확률 예보라 곡선 대신 **신고표**를 보여준다. 네 가지가 눈에 보이게:
//   ① 아무 정보 없이 찍어도 닿는 확률(p₀)이 기준선이다 — 쉬운 목표일수록
//      적중해도 조금 받는다 (무정보 대비 얼마나 위였는지만 센다)
//   ② **종목 변동성도 p₀의 입력이다** — 거친 종목을 고르면 p₀가 커져 보상이 줄어든다.
//      이 축이 없으면 "잘 출렁이는 종목만 골라 얻어걸리기"가 왜 안 통하는지 만져볼 수
//      없다. 그래서 자산군 평균을 기본값으로 두되 **직접 움직일 수 있게** 슬라이더로 낸다
//      (실제 카드는 게시 시점에 잰 그 종목의 120거래일 실현 변동성이 들어간다).
//      크기 하한도 같은 값에서 나오므로 슬라이더를 움직이면 하한이 따라 움직인다
//   ③ 실패 벌점은 게시 순간 확정된다 — 자기 하방을 알고 게시한다
//   ④ 손익분기 승률 = **신고 확률 그 자체** — 적정 점수법이라 정직 신고가 유일한 최적이다

function fmt(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(Math.round(n)).toLocaleString()}`;
}

export function ScoreCalculator() {
  const [assetClass, setAssetClass] = useState<AssetClass>("KR_EQUITY");
  const [up, setUp] = useState(true);
  const [magnitude, setMagnitude] = useState(10);
  const [horizonDays, setHorizonDays] = useState(30);
  const [confidence, setConfidence] = useState(4);
  /** 종목 변동성(하루 %) — 자산군 평균에서 출발하되 사용자가 움직인 뒤에는 그 값을 쓴다 */
  const [sigmaPct, setSigmaPct] = useState<number | null>(null);

  const direction = up ? ("UP" as const) : ("DOWN" as const);
  // 손대지 않았으면 자산군 평균 — 자산군을 바꾸면 기본값도 따라 바뀐다
  const sigma = sigmaPct ?? DAILY_SIGMA[assetClass] * 100;
  // 하한은 종목 변동성·기한의 함수다 — 변동성 슬라이더를 움직이면 하한도 따라 움직인다.
  // 게시가 막히는 크기는 계산기에서도 만들 수 없어야 화면과 규칙이 어긋나지 않는다
  const floor = minMagnitudePct(assetClass, sigma / 100, horizonDays);
  const size = Math.max(magnitude, floor);
  const stability = cardStabilityLevel(sigma / 100);

  const r = useMemo(() => {
    const s = sigma / 100;
    const p0 = noSkillTouchProbability(direction, size, assetClass, horizonDays, s);
    const hit = computeReachScore(direction, size, confidence, assetClass, horizonDays, true, s);
    const miss = computeReachScore(direction, size, confidence, assetClass, horizonDays, false, s);
    // 손익분기 승률 = **신고 확률 그 자체**다. 적정 점수법이라 기대 정보량이
    // p̂ = 진짜 확률에서 0을 넘어서므로, "이 신뢰도가 남으려면 그만큼 믿어야 한다"가
    // 곧 신고 확률이다. v4에서는 증폭 비율을 풀어야 나오던 값이 여기선 정의로 나온다
    return { p0, claimed: hit.claimed, hit: hit.score, miss: miss.score, breakEven: hit.claimed };
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
            min={CONFIDENCE_RANGE.min}
            max={CONFIDENCE_RANGE.max}
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
              — 점수는 신고한 확률이 이 기준선보다 얼마나 위였는지만 셉니다. 실제 카드에는
              게시 시점에 잰 그 종목의 최근 120거래일 실현 변동성이 들어갑니다
            </span>
          </div>
          <div className={styles.part}>
            <span className={styles.partKey}>적중하면</span>
            <span className={styles.partVal}>{fmt(r.hit)}점</span>
            <span className={styles.partNote}>
              ln({(r.claimed * 100).toFixed(0)}% ÷ {(r.p0 * 100).toFixed(0)}%) — 신고한 확률이
              무정보보다 얼마나 위였는지, 그 **정보량**만큼 받습니다. 쉬운 목표일수록,
              거친 종목일수록 무정보 확률이 커져 적게 받습니다
            </span>
          </div>
          <div className={styles.part}>
            <span className={styles.partKey}>실패하면</span>
            <span className={styles.partVal}>{fmt(r.miss)}점</span>
            <span className={styles.partNote}>
              게시하는 순간 확정되는 값입니다. 확신을 크게 신고할수록 틀렸을 때 더 잃습니다 —
              얼마나 크게 빗나갔는지는 들어가지 않습니다 (주장이 &quot;닿는다/못 닿는다&quot;라서)
            </span>
          </div>
        </div>

        <div className={styles.totalRow}>
          <span className={styles.totalLabel}>이 신뢰도가 신고하는 적중 확률</span>
          <span className={styles.total}>{(r.breakEven * 100).toFixed(0)}%</span>
        </div>
        <p className={styles.hint}>
          이보다 자주 맞힐 자신이 있을 때만 신뢰도 {confidence}이 남는 장사입니다. 신뢰도를
          한 칸 올리면 신고 승산이 ×1.73이 되고 틀렸을 때 잃는 양도 함께 커져서,
          자기가 믿는 확률을 그대로 신고하는 것이 수학적 최적입니다
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
