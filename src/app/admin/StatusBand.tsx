import type { StatusTick } from "@/server/statusBand";
import styles from "./admin.module.css";

// 상태 띠지 — 홈 맨 위를 흐르는 한 줄 (시안 v3 `.band`).
//
// 이용자 앱의 시장 규모 띠지(app/MarketTicker.tsx)를 그대로 옮겼다:
// 목록을 **두 벌** 이어 붙이고 한 벌 폭(-50%)만 움직이면 이음매가 안 보인다.
//
// **흐름은 어떤 입력에도 멈추지 않는다** — 읽는 것이 아니라 스치며 잡는 것이라
// 멈춰 세우는 장치 자체가 목적과 어긋난다(2026-08-09 확정). hover 정지를 뒀다가
// 모바일 터치가 hover로 잡혀 스치기만 해도 띠가 서 버린 적이 있다.
// prefers-reduced-motion에서는 흐르지 않고 그대로 눕는다(접근성은 통제가 아니라 존중).

export function StatusBand({ ticks }: { ticks: StatusTick[] }) {
  if (ticks.length === 0) return null;

  // 색으로만 구별되는 값이 없도록 상태를 글자로 함께 읽어 준다
  const spoken = ticks.map((t) => `${t.label} ${t.value}`).join(", ");

  return (
    <div className={styles.band} role="status" aria-label={`시스템 상태: ${spoken}`}>
      <div className={styles.track} aria-hidden="true">
        {[0, 1].map((pass) => (
          <span className={styles.run} key={pass}>
            {ticks.map((t) => (
              <span className={styles.tk} key={`${pass}-${t.label}`}>
                <span className={styles.tkLabel}>{t.label}</span>
                <strong
                  className={`${styles.tkValue} ${
                    t.tone === "on" ? styles.tkOn : t.tone === "off" ? styles.tkOff : ""
                  }`}
                >
                  {t.value}
                </strong>
              </span>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}
