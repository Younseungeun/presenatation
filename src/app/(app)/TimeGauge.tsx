import { TIME_GAUGE_STEPS, timeGaugeStep } from "@/domain/cardProgress";
import styles from "./timeGauge.module.css";

// 시간 경과 눈금 — 기울어진 획 4개(////). 구매한 카드의 우측 상단에 선다.
//
// 상황 막대에서 시간을 떼어낸 자리다(2026-08-10). 한 막대에 가격 채움과 시간 마커를
// 겹쳐 놨을 때는 둘이 같은 축의 두 값처럼 읽혀서, 막대를 볼 때마다 "이 색은 가격,
// 이 선은 시간"을 다시 해석해야 했다. 성격이 다른 두 진행은 형태부터 달라야 한다 —
// 막대는 연속(얼마나 왔나), 눈금은 이산(어느 구간인가).
//
// **기울인 이유**: 시간 경과는 중립적인 진도가 아니라 **재촉**이다(남은 시간이 줄면
// 되돌릴 여지도 준다). 기울기가 속도·긴박을 뜻하는 것은 계기판·스포츠 그래픽의 오랜
// 문법이라, 곧게 선 획이 못 내는 재촉이 각도 하나에서 나온다. 채워질수록 색이 오르는
// 경고 사다리(회색 → 초록 → 노랑 → 빨강)가 그 위에 얹힌다.
// 처음에는 느낌표(획+점)였으나 2026-08-10에 점을 걷고 눕혔다.
//
// **다른 기울기와 섞이지 않는다**: 앱에서 기울기가 데이터인 곳은 구매 **전** 카드의
// 배경 궤적과 DirectionGlyph(방향 = 기울기 모양)뿐인데, 둘 다 마스킹된 화면 전용이라
// 구매 후 카드에는 오지 않는다(§2.1). 여기서 기울기는 방향이 아니라 재촉을 뜻한다.
//
// 정확한 퍼센트는 4칸으로 표현할 수 없으므로 라벨에만 싣는다 — 눈금이 "32%"인 척
// 하지 않게 하고, 스크린 리더에는 정확한 값이 가는 구성.

const TONE_CLASS = [
  styles.t1, // 1칸 — 회색: 아직 초반, 재촉할 것이 없다
  styles.t2, // 2칸 — 초록
  styles.t3, // 3칸 — 노랑
  styles.t4, // 4칸 — 빨강: 마지막 사분면
];

export function TimeGauge({
  timeRatio,
  /** 눈금이 세는 대상 — 카드마다 "판정까지"·"판매 마감까지"로 달라진다 */
  label = "판정까지",
}: {
  timeRatio: number;
  label?: string;
}) {
  const step = timeGaugeStep(timeRatio);
  const pct = Math.round(timeRatio * 100);
  const text = `${label} 기간 ${pct}% 경과`;

  return (
    <span
      className={`${styles.gauge} ${TONE_CLASS[step - 1]}`}
      role="img"
      aria-label={text}
      title={text}
    >
      {Array.from({ length: TIME_GAUGE_STEPS }, (_, i) => (
        <svg
          key={i}
          className={i < step ? styles.on : styles.off}
          width="6"
          height="13"
          viewBox="0 0 6 13"
          fill="none"
          aria-hidden="true"
        >
          {/* 약 15° — 눕힌 티는 나되 글자 사이 사선(/)으로는 안 읽히는 각도.
              더 눕히면 획끼리 겹쳐 보이고, 덜 눕히면 곧은 획과 구별이 안 된다.
              둥근 끝: 각진 끝은 13px에서 기울기 때문에 한쪽 모서리만 뾰족해 보인다 */}
          <path
            d="M1.6 11.5L4.4 1.5"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
      ))}
    </span>
  );
}
