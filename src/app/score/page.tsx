import {
  DISCIPLINE_LADDER,
  MIN_MAGNITUDE_PCT,
  STABILITY_TOLERANCE,
} from "@/domain/scoring";
import { AppHeader } from "../AppHeader";
import { Disclaimer } from "../Disclaimer";
import { ScoreCalculator } from "./ScoreCalculator";
import styles from "../market.module.css";
import s from "./score.module.css";

export const metadata = { title: "점수 계산기 — INTOVILL" };

// 점수 계산기 화면.
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
          예측이 시한에 도달하면 시장 데이터로 자동 채점됩니다. 값을 움직여 보면 어떤
          경우에 얼마를 따고 잃는지 그대로 보입니다. 아래 계산은 실제 정산이 쓰는 것과
          같은 함수로 돌아갑니다.
        </p>

        <ScoreCalculator />

        <div className={styles.section}>이 모델이 지키는 것</div>
        <ol className={s.rules}>
          <li className={s.rule}>
            <span className={s.ruleNum}>1</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>잃는 양의 상한은 자기가 부른 크기다</div>
              <p className={s.ruleText}>
                방향이 반대로 가면 아무리 크게 빗나가도 잃는 거리는 정확히 예측 크기까지만
                입니다. 크게 부르면 크게 딸 수 있고 크게 잃습니다 — 주장의 크기가 곧 판돈
                입니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>2</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>작게 불러 안전하게 먹는 길이 없다</div>
              <p className={s.ruleText}>
                본전선은 예측의 절반 지점이고, 더 크게 맞혀도 점수는 예측 크기에서 멈춥니다.
                더 큰 점수를 얻는 유일한 방법은 처음부터 더 크게 부르는 것이라, 자기 믿음을
                그대로 신고하는 것이 수학적으로 가장 유리합니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>3</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>신뢰도는 공짜 증폭기가 아니다</div>
              <p className={s.ruleText}>
                맞으면 신뢰도 배만큼 늘지만 틀리면 그보다 가파르게 깎입니다. 그래서 확신이
                없을 때 신뢰도를 높이는 것은 언제나 손해이고, 자기 확신을 정직하게 적는 것이
                기대 점수를 최대로 만듭니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>4</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>안정성은 참가 여부부터 본인이 정한다</div>
              <p className={s.ruleText}>
                안정성 1은 진짜 불참이라 점수가 발동하지 않습니다. 2부터는 정밀도에 거는
                배팅이 되고, 예측에서{" "}
                {Math.round(STABILITY_TOLERANCE * 100)}% 넘게 빗나가면 벌점 구간에 들어갑니다.
                어느 지점에도 절벽이 없어 판정 시각을 노린 조작이 이득을 만들지 못합니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>5</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>찍어서 많이 내는 전략은 음수로 수렴한다</div>
              <p className={s.ruleText}>
                아무 정보 없이 낸 예측의 기대 점수는 증폭 이전에 이미 음수입니다. 누적 점수가
                내려가면 쓸 수 있는 최소 신뢰도가 강제로 올라가 하강이 더 빨라지고,{" "}
                {Math.abs(ladderTop.scoreBelow).toLocaleString()}점 아래로 내려가면 해당
                자산군의 신규 게시가 시즌 종료까지 정지됩니다.
              </p>
            </div>
          </li>
          <li className={s.rule}>
            <span className={s.ruleNum}>6</span>
            <div className={s.ruleBody}>
              <div className={s.ruleTitle}>화면의 별점은 승률로 읽는다</div>
              <p className={s.ruleText}>
                신뢰도·안정성 별점은 다이얼값(1~10)을 반으로 접은 것이 아니라, 그 신고가
                손해가 아니려면 리서처가 스스로 믿어야 하는 최소 승률 × 별 5개입니다.
                신뢰도 3이 별 3.75개인 이유는 그 신고가 승률 75%를 함의하기 때문입니다
                (신뢰도 c → c/(c+1), 안정성 s → (s−1)/s, 안정성 1은 불참이라 별 0개).
                그래서 별 5개는 승률 100%라 존재하지 않고, 위로 갈수록 별 반 개가
                기하급수적으로 어려워집니다. 이 규칙은 표시일 뿐 점수 계산에는 영향이
                없습니다.
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
            <span className={styles.cardKey}>신뢰도 증폭</span>
            <span className={styles.cardVal}>맞으면 ×c · 틀리면 ×c(c+1)/2</span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>안정성 허용 오차</span>
            <span className={styles.cardVal}>
              {STABILITY_TOLERANCE} (초과 방향은 1.5배 관대)
            </span>
          </div>
          <div className={styles.cardRow}>
            <span className={styles.cardKey}>표본 제외</span>
            <span className={styles.cardVal}>실현 0% · 판정 불가 · 철회</span>
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
