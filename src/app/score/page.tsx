import { DISCIPLINE_LADDER, MIN_MAGNITUDE_PCT } from "@/domain/scoring";
import { AppHeader } from "../AppHeader";
import { Disclaimer } from "../Disclaimer";
import { ScoreCalculator } from "./ScoreCalculator";
import styles from "../market.module.css";
import s from "./score.module.css";

export const metadata = { title: "점수 계산기 — INTOVILL" };

// 점수 계산기 화면 (모델 v4 — 공정배당 이항).
//
// 왜 별도 화면인가: 점수 모델은 등급의 유일한 기준이라 이 서비스에서 가장 민감한
// 규칙이다. "우리는 공정하다"는 문장 백 개보다 직접 만져보는 계산기 하나가 낫다.
// 다만 랭킹 화면에 인라인으로 박으면 순위를 훑으러 온 사람의 목적을 방해하므로,
// 진입점만 랭킹·작성 화면에 두고 계산기는 여기로 분리했다.
//
// 로그인 없이 열린다 — 구매자에게도 "이 순위가 조작 가능한가"를 확인시켜야 한다.

export default function ScorePage() {
  const ladderTop = DISCIPLINE_LADDER[DISCIPLINE_LADDER.length - 1];

  return (
    <>
      <AppHeader title="점수 계산기" backHref="/ranking" />
      <main className={styles.page}>
        <p className={styles.sub}>
          예측 카드는 &quot;기한 안에 목표가에 닿는다&quot;(일봉 종가 기준)는 주장이고,
          닿으면 적중·못 닿으면 실패로 자동 채점됩니다. 값을 움직여 보면 어떤 경우에
          얼마를 따고 잃는지 그대로 보입니다. 아래 계산은 실제 정산이 쓰는 것과 같은
          함수로 돌아갑니다.
        </p>

        <ScoreCalculator />

        <div className={styles.section}>이 모델이 지키는 것</div>
        <ol className={s.rules}>
          <li className={s.rule}>
            <span className={s.ruleNum}>1</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>공짜 확률은 먼저 공제된다</div>
              <p className={s.ruleText}>
                어떤 목표든 아무 정보 없이 찍어도 우연히 닿을 확률(p₀)이 있습니다 — 쉬운
                목표일수록 큽니다. 적중 보상은 (1 − p₀)에 비례해서, 우연의 몫을 빼고
                실력의 몫만 지급합니다. 그래서 &quot;쉬운 목표로 적중률만 쌓는&quot;
                전략은 점수가 거의 늘지 않습니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>2</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>잃는 양은 게시하는 순간 확정된다</div>
              <p className={s.ruleText}>
                실패 벌점은 p₀에 비례하는 고정값이라, 카드를 게시하는 순간 하방이
                정해집니다. 얼마나 크게 빗나갔는지는 점수에 들어가지 않습니다 — 주장이
                &quot;닿는다/못 닿는다&quot;이기 때문입니다. 실현 등락은 기록으로 남아
                프로필에 그대로 표시됩니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>3</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>신뢰도는 &quot;무정보 대비 몇 배 확신하나&quot;다</div>
              <p className={s.ruleText}>
                맞으면 신뢰도 배(×c)만큼 늘지만 틀리면 그보다 가파르게(×c(c+1)/2)
                깎입니다. 수학적으로 신뢰도 c가 남는 장사가 되려면 자기 승산이 무정보
                승산의 c배는 되어야 합니다 — 자기 확신을 정직하게 적는 것이 기대 점수를
                최대로 만듭니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>4</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>찍어서 많이 내는 전략은 못 번다</div>
              <p className={s.ruleText}>
                무정보 예측의 기대 점수는 어떤 크기·기간·자산군을 골라도 0 이하입니다
                (수식으로 보장됩니다). 누적 점수가 내려가면 쓸 수 있는 최소 신뢰도가
                강제로 올라가 하강이 가속되고,{" "}
                {Math.abs(ladderTop.scoreBelow).toLocaleString()}점 아래로 내려가면 해당
                자산군의 신규 게시가 시즌 종료까지 정지됩니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>5</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>판정 시각을 노린 조작이 통하지 않는다</div>
              <p className={s.ruleText}>
                도달은 일봉 종가로만 인정됩니다 — 장중에 순간적으로 스친 가격은 판정에
                들어가지 않아, 시세를 잠깐 튀겨 적중을 만드는 조작이 성립하지 않습니다.
                적중 시 점수는 도달한 날 판정하든 기한까지 기다리든 같습니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>6</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>화면의 별점은 승률로 읽는다</div>
              <p className={s.ruleText}>
                신뢰도 별점은 다이얼값(1~10)을 반으로 접은 것이 아니라, 그 신고가 손해가
                아니려면 리서처가 스스로 믿어야 하는 최소 승률 × 별 5개입니다 (기준
                상황에서 신뢰도 c → c/(c+1); 실제 문턱은 카드의 난이도 p₀에 따라
                움직입니다). 별 5개는 승률 100%라 존재하지 않습니다. 이 규칙은 표시일 뿐
                점수 계산에는 영향이 없습니다.
              </p>
            </div>
          </li>
        </ol>

        <div className={styles.section}>계산에 쓰이는 값</div>
        <div className={styles.cardBox}>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>예측 크기 하한</span>
            <span className={styles.cardVal}>
              국내·미국주식 {MIN_MAGNITUDE_PCT.KR_EQUITY}% · 코인{" "}
              {MIN_MAGNITUDE_PCT.CRYPTO}%
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>적중 / 실패</span>
            <span className={styles.cardVal}>
              +10×크기×c×(1−p₀) / −10×크기×c(c+1)/2×p₀
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>무정보 확률 p₀</span>
            <span className={styles.cardVal}>
              방향·크기·기간·자산군 변동성의 함수 (게시 사양에서 결정)
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>표본 제외</span>
            <span className={styles.cardVal}>판정 불가 · 철회</span>
          </div>
        </div>

        <p className={s.ruleText} style={{ marginTop: 14 }}>
          점수는 시즌(분기)마다 자산군별로 합산되어 등급을 정합니다. 세부 가중치 중 어뷰징
          탐지에 쓰이는 부분은 공개하지 않지만, 위 계산식 자체는 그대로입니다.
        </p>

        <Disclaimer />
      </main>
    </>
  );
}
