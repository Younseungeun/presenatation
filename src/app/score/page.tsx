import { DISCIPLINE_ALPHA, MAGNITUDE_FLOOR_K } from "@/domain/scoring";
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
                목표일수록, 그리고 <strong>잘 출렁이는 종목일수록</strong> 큽니다(그 종목의
                최근 120거래일 실현 변동성을 게시 시점에 재서 카드에 고정합니다). 점수는
                신고한 확률이 <strong>이 p₀보다 얼마나 위였는지</strong>만 셉니다.
                그래서 &quot;쉬운 목표로 적중률만 쌓는&quot; 전략도, &quot;거친 종목만
                골라 얻어걸리길 노리는&quot; 전략도 점수가 거의 늘지 않습니다.
                예측 크기의 하한도 그 종목의 변동성에 맞춰 움직입니다 — 거친 종목일수록
                더 큰 목표를 걸어야 합니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>2</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>잃는 양은 게시하는 순간 확정된다</div>
              <p className={s.ruleText}>
                실패 벌점은 게시 사양만으로 정해지는 고정값이라, 카드를 올리는 순간 하방이
                확정됩니다. 얼마나 크게 빗나갔는지는 점수에 들어가지 않습니다 — 주장이
                &quot;닿는다/못 닿는다&quot;이기 때문입니다. 한 장이 얻거나 잃을 수 있는
                양에도 <strong>천장이 있습니다</strong> — 카드 한 장이 시즌 성적을 통째로
                뒤엎지 못합니다. 실현 등락은 기록으로 남아 프로필에 그대로 표시됩니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>3</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>신뢰도는 확률 신고다</div>
              <p className={s.ruleText}>
                신뢰도 한 칸은 무정보 대비 승산 ×1.73, 꼭대기(10)는 ×140입니다. 즉 신뢰도를
                고르는 것은 <strong>&quot;나는 이 확률로 맞힌다&quot;고 신고하는 것</strong>이고,
                점수는 그 신고가 맞았는지를 잽니다. <strong>믿는 그대로 적는 것이 유일한
                최적</strong>입니다 — 부풀리면 틀렸을 때 더 잃고, 낮추면 맞았을 때 덜 받습니다.
                남기려면 신고한 확률보다 자주 맞히면 됩니다. 그래서 이 화면의 손익분기
                승률은 계산 결과가 아니라 <strong>신고한 확률 그 자체</strong>입니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>4</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>찍어서 많이 내는 전략은 못 번다</div>
              <p className={s.ruleText}>
                무정보 예측의 기대 점수는 어떤 크기·기간·자산군·<strong>종목</strong>을
                골라도 0 이하입니다 (수식으로 보장됩니다 — 종목이 거칠면 p₀가 그만큼 커져
                보상이 줄기 때문에 변동성만 노리는 선택으로는 이 부등호를 뒤집을 수 없습니다).
                여기에 더해, 신고한 확신이 실제 적중과 거듭 어긋나면{" "}
                <strong>쓸 수 있는 신뢰도의 상한이 내려갑니다</strong>{" "}— 확신을 크게 부르는
                것으로 카드를 돋보이게 하는 길이 닫힙니다. 문턱은 통계 검정에서 나옵니다:
                각 단은 &quot;정직하게 신고하는 사람이 잘못 걸릴 확률&quot;이 각각{" "}
                {DISCIPLINE_ALPHA.map((a) => `${a * 100}%`).join(" · ")} 이하가 되도록
                잡혀 있고, 가장 깊은 단에서는 해당 자산군의 신규 게시가 시즌 종료까지
                정지됩니다. 적중이 쌓이면 자동으로 풀립니다.
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
              <div className={s.ruleTitle}>별 한 칸은 어디서나 같은 뜻이다</div>
              <p className={s.ruleText}>
                신뢰도 별점은 다이얼값에 선형입니다 (2 → ★1 … 10 → ★5). 사다리가 등비라
                <strong> 별 한 칸이 어느 구간에서든 승산 ×1.73</strong>을 뜻합니다 — ★1과
                ★2의 차이가 ★4와 ★5의 차이와 같습니다. 그 칸이 실제로 몇 %인지는 카드
                난이도(p₀)에 따라 달라지므로, 정확한 확률은 리포트 상세와 작성 화면에
                카드마다 따로 적습니다. 이 규칙은 표시일 뿐 점수 계산에는 영향이 없습니다.
              </p>
            </div>
          </li>
        </ol>

        <div className={styles.section}>계산에 쓰이는 값</div>
        <div className={styles.cardBox}>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>예측 크기 하한</span>
            <span className={styles.cardVal}>
              {MAGNITUDE_FLOOR_K} × 종목 변동성 × √기한
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>적중 / 실패</span>
            <span className={styles.cardVal}>
              100×가중×ln(p̂/p₀) / 100×가중×ln((1−p̂)/(1−p₀))
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>신고 확률 p̂</span>
            <span className={styles.cardVal}>
              무정보 승산 × 140^((c−1)/9) — 신뢰도 한 칸이 ×1.73
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>무정보 확률 p₀</span>
            <span className={styles.cardVal}>
              방향·크기·기간·그 종목의 실현 변동성의 함수 (게시 시점에 고정)
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
