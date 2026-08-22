import a from "../admin.module.css";

/**
 * 재학습 신호 계기판 — **숫자 하나뿐이다.**
 *
 * 재는 것은 "IRIS의 판단과 운영자의 최종 판정이 엇갈린 건수"이고, 그 수가 문턱에
 * 닿으면 재학습할 때다. 지금까지 이 숫자를 알려면 터미널을 열어야 했다.
 *
 * ── 목록은 만들지 않는다 ────────────────────────────────────────
 * **자료를 화면에서 고르기 시작하면 "마음에 드는 것만 학습시키는" 길이 열린다.**
 * 그리고 이 목록은 운영자 **자신의 판정을 재심하는 재료**라, 판정 당사자가 보면 다음
 * 판정이 목록을 의식한다(X-6 비노출). 목록이 필요한 곳은 학습 내보내기(CLI)뿐이고
 * 그건 운영자 화면이 아니다.
 *
 * ── 문턱은 재학습이 아니라 **심사**의 시작이다 ──────────────────
 * 엇갈림은 두 가지에서 같은 값을 올린다: IRIS가 틀렸을 때와, **운영자가 실수했는데
 * IRIS가 맞았을 때**. 운영자 실수를 그대로 학습시키면 IRIS가 실수를 배운다. 그래서
 * 50건이 차면 곧장 재학습이 아니라 **창업자(제3자)가 진위를 가리는 자리**로 넘어간다.
 * 문구가 그 사실을 말해야 한다 — "재학습 준비 완료"라고 적으면 심사 단계가 사라진다.
 */
export function RetrainGauge({
  count,
  threshold,
  reached,
  sinceAdoptedAt,
}: {
  count: number;
  threshold: number;
  reached: boolean;
  sinceAdoptedAt: Date | null;
}) {
  const pct = Math.min(100, Math.round((count / threshold) * 100));

  return (
    <section
      style={{
        margin: "0 16px 12px",
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${reached ? "var(--warn)" : "var(--line)"}`,
        fontSize: 13,
        color: "var(--text-weak)",
      }}
    >
      <div className={a.row}>
        <strong style={{ color: "var(--text)" }}>
          재학습 신호{" "}
          <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
            · IRIS와 운영자가 엇갈린 건수
          </span>
        </strong>
        <span className={`${a.chip} ${reached ? a.chipWarn : ""}`}>
          {count} / {threshold}
        </span>
      </div>

      {/* 막대는 눈금이 아니라 **거리감**이다 — 47/50 과 12/50 이 같은 크기의 글자로만
          있으면 곁눈질로 구별되지 않는다 */}
      <div
        aria-hidden="true"
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--line)",
          overflow: "hidden",
          margin: "8px 0",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: reached ? "var(--warn)" : "var(--text-faint)",
          }}
        />
      </div>

      {reached ? (
        <div>
          <b style={{ color: "var(--warn)" }}>{threshold}건에 닿았습니다 — 창업자 진위 심사 대기.</b>{" "}
          이 표본에는 <b>IRIS가 틀린 건</b>과 <b>운영자가 실수했는데 IRIS가 맞은 건</b>이 섞여
          있습니다. 가리지 않고 학습시키면 IRIS가 운영자의 실수를 배웁니다.
        </div>
      ) : (
        <div>
          {threshold}건이 차면 창업자가 진위를 가린 뒤 재학습으로 넘어갑니다.
          {/* 채택 시점이 없으면 카운터가 **처음부터 전부**를 세고 있다는 뜻이다.
              그 사실을 말하지 않으면 숫자가 무엇의 누적인지 알 수 없다 */}
          {sinceAdoptedAt ? (
            <> 마지막 채택({sinceAdoptedAt.toLocaleDateString("ko-KR")}) 이후로 셉니다.</>
          ) : (
            <> 아직 채택 기록이 없어 처음부터 전부 세고 있습니다.</>
          )}
        </div>
      )}
    </section>
  );
}
