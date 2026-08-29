import type { RollbackStatus } from "@/domain/studentRollback";
import { StudentShadowRelease } from "../StudentShadowRelease";

/**
 * **IRIS 순이익 상세** — 계기판에서 이 자리로 내려왔다 (2026-08-29 창업자 지시).
 *
 * 평소 이 숫자는 0/50 에서 며칠씩 안 움직인다 — 매일 보는 계기판에서 안 변하는 숫자는
 * 읽히지 않고 자리만 차지한다. 그래서 상세(되짚으러 오는 화면)로 옮기고, 계기판에는
 * **정지(자동 격하)일 때만 칩** 하나로 남긴다. 켜둘 값어치를 되짚어보는 값이라
 * 여기가 집이다.
 *
 * 채택선과 **같은 공식**(순이익)으로 최근 창을 다시 잰다 — 켤 때와 끌 때의 잣대가
 * 다르면 두 판단이 서로를 반박한다.
 */
export function StudentRollbackDetail({
  rollback,
  autoShadowed,
}: {
  rollback: RollbackStatus;
  autoShadowed: boolean;
}) {
  // 표본이 없고 격하도 아니면 그리지 않는다 — 0건짜리 계기판은 정보가 아니라 장식이다
  if (rollback.scored === 0 && !autoShadowed) return null;

  const alarming = autoShadowed || rollback.shouldRollback;
  return (
    <section
      style={{
        margin: "0 0 12px",
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${alarming ? "var(--neg)" : "var(--line)"}`,
        background: alarming ? "var(--neg-weak, #fff5f5)" : "transparent",
        fontSize: 13,
        color: "var(--text-weak)",
      }}
    >
      <strong style={{ color: "var(--text)" }}>IRIS 순이익</strong>{" "}
      <span style={{ color: "var(--text-faint)" }}>· 운영자 판정 기준</span>
      <br />
      {rollback.summary}
      {/* 격하됐으면 **그 사실이 먼저다.** 위 순이익은 격하 이후로 갱신되지 않는다 —
          IRIS가 소견을 안 내므로 잴 재료 자체가 없다. 그 사실을 말하지 않으면
          운영자가 "숫자가 안 나빠졌으니 괜찮다"로 읽는다 (10차 I-6). */}
      {autoShadowed ? (
        <>
          <br />
          <strong style={{ color: "var(--neg)" }}>
            자동 격하됨 — 지금 규칙 단독으로 검수 중입니다.
          </strong>
          <br />
          위 수치는 격하 시점에 멈춰 있습니다(끈 동안에는 IRIS의 성적을 잴 수 없습니다).
          재학습하고 <code>npm run eval:student</code> 로 채택선을 다시 통과시킨 뒤
          해제하십시오.
          <StudentShadowRelease />
        </>
      ) : (
        rollback.shouldRollback && (
          <>
            <br />
            <strong style={{ color: "var(--neg)" }}>
              적자입니다 — 다음 검수 때 자동으로 격하됩니다.
            </strong>
          </>
        )
      )}
    </section>
  );
}
