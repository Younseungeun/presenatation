import type { CanaryScreen } from "@/server/screeningCanaryRunner";
import { SCREENING_CANARY, type CanaryCase } from "@/domain/screeningCanary";
import { SecHead } from "../../Why";
import a from "../../admin.module.css";
/* 신호등은 IRIS 칩과 **같은 부품**을 쓴다 — 한 화면에서 "정상"을 두 가지 모양으로
   그리면 둘이 다른 뜻인 줄 알게 된다 (2026-08-24 창업자 지시) */
import s from "../irisStatus.module.css";

/**
 * **검수 규칙 상세** — 계기판의 `검수 규칙` 줄을 펼친 자리 (2026-08-23 창업자 지시).
 *
 * 예전에는 계기판 본문에 띠지로 상시 떠 있었다. 전부 통과일 때는 초록 여섯 개가 아무
 * 말도 하지 않으면서 화면만 먹어 걷었고, 대신 여기로 옮겼다 — 되짚을 때 오는 자리다.
 *
 * ── 왜 기록을 읽지 않고 직접 재는가 ────────────────────────────
 * 스케줄러가 5분마다 돌려 성공 시각(박동)을 남기지만 **실패 내용은 어디에도 저장되지
 * 않는다**(알림 본문에만 있고 사라진다). 박동만 읽으면 화면이 할 수 있는 말은 "5분
 * 전엔 괜찮았다"까지고, 정작 필요한 "어느 층이 죽었나"는 못 답한다.
 * 여기서 직접 돌리는 비용은 정규식 6번 + 조회 2번이다(AI 호출 0, 종목명은 캐시).
 *
 * ── 층마다 한 칸인 이유 ────────────────────────────────────────
 * 문항 하나만 두면 1층이 살아 있는 한 초록이라 **정작 이번에 죽은 4층을 못 본다.**
 * 2026-08-20에 표기 회피 탐지가 통째로 꺼진 채 돌았는데(차단율 92% → 실제 0%)
 * 예외도 경고도 없었고 시험 820건이 전부 초록이었다. 그 사고를 잡는 자리가 `훼손신호` 칸이다.
 */

/**
 * 층 목록은 **문항에서 뽑는다 — 여기 적지 않는다** (2026-08-21 실제 사고).
 *
 * 처음에는 층 이름을 배열로 박아 뒀다. 서버가 `사전입력` 문항을 늘렸을 때 **화면은
 * 5칸을 그대로 그렸고 타입 에러도 안 났다** — 별도 배열이라 union이 늘어도 컴파일러가
 * 볼 자리가 없다. 늘어난 층이 죽어도 띠지는 초록이었다는 뜻이다.
 *
 * 카나리아가 잡으려는 고장(**조용히 꺼진 채 초록**)을 카나리아 화면이 똑같이 저질렀다.
 * 등장 순서를 지킨다 — `SCREENING_CANARY`가 1층부터 차례로 적혀 있어 그 순서가 곧
 * 검수가 글을 훑는 순서다.
 */
const LAYERS: readonly CanaryCase["layer"][] = [...new Set(SCREENING_CANARY.map((c) => c.layer))];

/**
 * 층이 **무슨 논리로 도는지** 한 줄 (2026-08-24 창업자 지시).
 *
 * 층 이름만으로는 `깊은정규화`가 무엇을 하는 층인지 알 수 없고, 그러면 그 칸이 빨개져도
 * 무엇이 뚫린 것인지 모른다. 실패했을 때의 사연(`meaning`)은 **잃는 것**을 말하고
 * 이 줄은 **평소에 하는 일**을 말한다 — 둘은 다른 질문이라 자리도 다르다.
 *
 * ⚠ **문항의 정답을 적지 않는다.** 여기 적힌 것이 그대로 회피 지도가 되면 안 되므로
 * (`docs/screening-known-limits.md` 가 리서처 비공개인 것과 같은 이유) 방식만 적고
 * 실제 패턴·문구는 적지 않는다. 운영자·개발자만 보는 화면이지만 습관을 여기서 들인다.
 */
const LAYER_LOGIC: Record<CanaryCase["layer"], React.ReactNode> = {
  원문: "손대지 않은 글에 정규식을 그대로 돌립니다 — 검수의 바닥",
  기호제거: "글자 사이에 낀 기호·공백을 걷어 붙여 읽습니다. 간격이 고르면 회피로 봅니다",
  깊은정규화: "유니코드를 정규화하고 낱자를 글자로 합칩니다 — 자모·특수문자 회피 방어",
  훼손신호: (
    <>
      뜻을 풀지 않고 <b>바꿨다는 사실</b>만 봅니다. 등록 종목명은 예외로 뺍니다
    </>
  ),
  사전입력: "운영자가 등록한 표현을 같은 정규화에 태워 맞춰 봅니다 (항상 WARN)",
  정상문항: (
    <>
      <b>걸리면 안 되는 문장</b>을 넣습니다 — 규칙이 미쳐 전부 잡는 상태를 잡는 칸
    </>
  ),
};

/**
 * 박동은 **얼마나 됐나**만 말한다. "한 번도 없음"과 "오래됨"을 한 낱말로 뭉치지 않는다:
 * 둘 다 낡은 상태지만 사람에게는 다른 사실이라(설치 직후인가, 돌던 것이 멈췄나) 처방도 다르다.
 */
function beatValue(from: Date | null, now: Date): string {
  if (!from) return "기록 없음";
  const sec = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1_000));
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hours = Math.floor(min / 60);
  return hours < 24 ? `${hours}시간 전` : `${Math.floor(hours / 24)}일 전`;
}

export function RuleDetail({
  screen,
  now,
  schedulerOff,
  intervalMs,
  staleMs,
}: {
  screen: CanaryScreen;
  now: Date;
  /** 스케줄러 심박이 낡았는가 — 그러면 자동 점검 칸은 "그 고장"을 가리킨다 */
  schedulerOff: boolean;
  intervalMs: number;
  staleMs: number;
}) {
  // 층별로 접는다 — 한 층에 문항이 둘인 곳이 있고(정상문항), 그 둘 중 하나만 죽어도
  // 그 층은 죽은 것이다
  const failedLayers = new Set(screen.failures.map((f) => f.layer));

  const staleMin = Math.round(staleMs / 60_000);
  const intervalMin = Math.round(intervalMs / 60_000);

  return (
    <>
      <SecHead title="검수 규칙">
        <span>
          정답이 정해진 문장 {screen.ran}개를 <b>운영과 같은 함수</b>에 통과시켜 잽니다 — 이 화면을
          열 때마다 지금 다시 재고, 스케줄러도 {intervalMin}분마다 같은 것을 돌립니다.
        </span>{" "}
        <span>
          {SCREENING_CANARY.filter((c) => c.expect.length === 0).length}개는 <b>정상 문항</b>입니다.
          잡아야 할 것만 재면 규칙이 미쳐서 <b>전부 잡는 상태</b>도 초록이 됩니다.
        </span>{" "}
        <span>
          빨간 칸은 &ldquo;그 층이 통과시키는 리포트를 지금 아무도 막지 않는다&rdquo;는 뜻입니다.
        </span>
      </SecHead>

      {/* **띠지가 아니라 상자다** (2026-08-24 창업자 지시).
          띠지는 흐르면서 같은 칸을 두 번 그리는 물건이라 **곁눈질**에 맞는 형태였고,
          여기는 되짚으러 와서 **읽는** 자리다. 상자로 세우면 층이 세로로 서서
          검수가 글을 훑는 순서 그대로 읽히고, 죽은 층의 사연을 그 줄에 붙일 수 있다 —
          띠지에서는 사연을 아래 별도 문단으로 뺄 수밖에 없어 눈이 두 번 오갔다.
          위 정확도 상자와 같은 문법이라 이 화면이 한 종류의 물건으로 읽힌다 */}
      <div className={a.card}>
        {LAYERS.map((layer) => {
          const fails = screen.failures.filter((f) => f.layer === layer);
          const dead = fails.length > 0;
          return (
            <div key={layer} className={a.row} style={{ padding: "7px 0", alignItems: "center" }}>
              {/* **상태는 글자가 아니라 신호등이다** (2026-08-24 창업자 지시 — IRIS 칩과
                  같은 부품). `통과`라는 글자는 읽어야 하고, 읽는 동안 옆 설명과 경쟁한다.
                  여섯 줄을 세로로 훑을 때 필요한 것은 "어디가 빨간가" 하나뿐이다.
                  이상은 점이 아니라 **느낌표**다 — 색만 바꾸면 색각 이상과 흑백에서
                  사라지므로 형태가 달라야 한다 (irisStatus.module.css 주석) */}
              {dead ? (
                <span className={s.alert} title="실패" aria-hidden="true">
                  !
                </span>
              ) : (
                <span className={s.dot} title="통과" aria-hidden="true" />
              )}
              <span style={{ minWidth: 76, fontWeight: 700 }}>{layer}</span>
              {/* 색으로만 구별되지 않도록 상태를 글자로도 읽어 준다 (화면에는 안 보인다) */}
              <span className={a.srOnly}>{dead ? "실패" : "통과"}</span>
              {/* **오른편은 그 층이 무슨 논리로 도는지** — 죽었으면 그 자리를 사연이
                  대신한다. 평소에는 "무엇을 하는 칸인가", 빨개지면 "무엇을 잃었나"라
                  같은 자리에서 답이 바뀐다 */}
              <span
                style={{
                  flex: 1,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: dead ? "#c4303b" : "var(--text-muted)",
                }}
              >
                {dead
                  ? fails.map((f) => (
                      <span key={f.id}>
                        {f.meaning}
                        {f.missing.length > 0 && <> — 못 잡음: {f.missing.join(", ")}</>}
                        {f.unexpected.length > 0 && <> — 잘못 잡음: {f.unexpected.join(", ")}</>}
                      </span>
                    ))
                  : LAYER_LOGIC[layer]}
              </span>
            </div>
          );
        })}

        {/* **자동 점검은 층이 아니다** — 규칙은 멀쩡한데 점검만 멈출 수 있고, 그러면
            다음 고장을 아무도 먼저 알려주지 않는다. 같은 상자에 두되 선으로 가른다
            (띠지 시절 "같은 띠에 태우되 칸은 나눈다"와 같은 판단) */}
        <div
          className={a.row}
          style={{
            padding: "9px 0 0",
            marginTop: 4,
            borderTop: "1px solid var(--border)",
            alignItems: "baseline",
          }}
        >
          {schedulerOff || screen.heartbeatStale ? (
            <span className={s.alert} aria-hidden="true">
              !
            </span>
          ) : (
            <span className={s.dot} aria-hidden="true" />
          )}
          <span style={{ minWidth: 76, fontWeight: 700 }}>자동 점검</span>
          <b
            style={{
              fontSize: 12.5,
              color: schedulerOff || screen.heartbeatStale ? "#c4303b" : "var(--text-mid)",
            }}
          >
            {schedulerOff ? "스케줄러 꺼짐" : beatValue(screen.lastOkAt, now)}
          </b>
          {/* 이 칸만 값이 시각이라 설명 자리에 **주기**를 적는다 — "4분 전"이 정상인지
              늦은 것인지는 주기를 알아야 판단된다 */}
          <span style={{ flex: 1, fontSize: 12, color: "var(--text-muted)" }}>
            스케줄러가 {intervalMin}분마다 같은 문항을 돌립니다
          </span>
        </div>

        <div className={a.meta}>
          <span>
            층 {LAYERS.length - failedLayers.size}/{LAYERS.length} 통과
          </span>
          <span>문항 {screen.ran}개</span>
          {screen.nextAt && !schedulerOff && !screen.heartbeatStale && (
            <span>다음 점검 {screen.nextAt.toLocaleTimeString("ko-KR")}</span>
          )}
        </div>
      </div>

      {/* **두 고장을 갈라 적는다** — 처방이 다르다 (스케줄러를 켠다 / 카나리아 작업을 본다) */}
      {schedulerOff ? (
        <div className={`${a.note} ${a.noteWarn}`}>
          스케줄러가 멎어 있어 자동 점검이 돌지 않습니다. 위 칸들은 이 화면이 방금 직접 잰
          값이라 지금은 맞지만, <b>화면을 닫아 두는 동안에는 아무도 재지 않습니다.</b>
        </div>
      ) : (
        screen.heartbeatStale && (
          <div className={`${a.note} ${a.noteWarn}`}>
            {screen.lastOkAt
              ? `자동 점검이 ${staleMin}분 넘게 성공하지 않았습니다.`
              : "자동 점검이 한 번도 돌지 않았습니다."}{" "}
            스케줄러 자체는 살아 있으므로 <b>카나리아 작업만 멈춘 상태</b>입니다 — 그쪽 로그를
            확인하세요.
          </div>
        )
      )}

      {/* **값은 상자가, 단서는 이 줄이 말한다.** 띠지 시절에는 여기서 마지막 통과와 다음
          점검을 함께 적었는데, 상자가 둘 다 이미 그리므로 그대로 두면 한 화면에 같은
          시각이 두 번 뜬다 — 남는 것은 그 시각을 **어떻게 읽어야 하는가**뿐이다 */}
      {!schedulerOff && !screen.heartbeatStale && screen.nextAt && (
        <div className={a.note}>
          다음 점검 시각은 스케줄러가 적어 둔 값이라 주기를 바꿔도 이 화면이 따라옵니다.
        </div>
      )}
    </>
  );
}
