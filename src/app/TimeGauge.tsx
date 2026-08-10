import { TIME_GAUGE_STEPS, timeGaugeStep } from "@/domain/cardProgress";
import styles from "./timeGauge.module.css";

// 시간 경과 눈금 — 느낌표 4개. 구매한 카드의 우측 상단에 선다.
//
// 상황 막대에서 시간을 떼어낸 자리다(2026-08-10). 한 막대에 가격 채움과 시간 마커를
// 겹쳐 놨을 때는 둘이 같은 축의 두 값처럼 읽혀서, 막대를 볼 때마다 "이 색은 가격,
// 이 선은 시간"을 다시 해석해야 했다. 성격이 다른 두 진행은 형태부터 달라야 한다 —
// 막대는 연속(얼마나 왔나), 눈금은 이산(어느 구간인가).
//
// **느낌표인 이유**: 시간 경과는 중립적인 진도가 아니라 **재촉**이다. 남은 시간이
// 줄수록 되돌릴 수 있는 여지도 줄기 때문에, 채워질수록 색이 올라가는 경고 사다리가
// 이 값의 성질에 맞는다 (회색 → 초록 → 노랑 → 빨강).
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
          width="5"
          height="13"
          viewBox="0 0 5 13"
          fill="currentColor"
          aria-hidden="true"
        >
          {/* 획 + 점 — 13px에서도 느낌표로 읽히려면 둘 사이 간격이 획 굵기보다 커야 한다.
              굵기를 변주하지 않는다: 5px 폭에서 테이퍼는 안티에일리어싱에 먹힌다 */}
          <path
            d="M2.5 1.4V8.1"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
          />
          <circle cx="2.5" cy="11.4" r="1.4" />
        </svg>
      ))}
    </span>
  );
}
