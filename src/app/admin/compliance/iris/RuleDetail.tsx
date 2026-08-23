import type { CanaryScreen } from "@/server/screeningCanaryRunner";
import type { StatusTick } from "@/server/statusBand";
import { SCREENING_CANARY, type CanaryCase } from "@/domain/screeningCanary";
import { StatusBand } from "../../StatusBand";
import { SecHead } from "../../Why";
import a from "../../admin.module.css";

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
  const ticks: StatusTick[] = LAYERS.map((layer) => {
    const dead = failedLayers.has(layer);
    return { label: layer, value: dead ? "실패" : "통과", tone: dead ? "off" : "on" };
  });

  /* 자동 점검은 **다른 고장**이다 — 규칙은 멀쩡한데 점검만 멈춰 있을 수 있고, 그러면
     다음 고장을 아무도 먼저 알려주지 않는다. 같은 띠에 태우되 칸은 나눈다.
     스케줄러가 통째로 꺼져 있으면 그 사실을 적는다 — "기록 없음"이라고만 쓰면
     고치러 갈 곳이 규칙인지 스케줄러인지 알 수 없다 */
  ticks.push({
    label: "자동 점검",
    value: schedulerOff ? "스케줄러 꺼짐" : beatValue(screen.lastOkAt, now),
    tone: schedulerOff || screen.heartbeatStale ? "off" : "on",
  });

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

      <StatusBand ticks={ticks} />

      {/* 죽은 층은 **무엇을 잃는지**를 그 자리에서 말한다 — 층 이름만으로는
          지금 무엇이 통과되고 있는지 알 수 없다 */}
      {screen.failures.map((f) => (
        <div key={f.id} className={`${a.note} ${a.noteNeg}`}>
          <b>[{f.layer}]</b> {f.meaning}
          {f.missing.length > 0 && <> — 못 잡음: {f.missing.join(", ")}</>}
          {f.unexpected.length > 0 && <> — 잘못 잡음: {f.unexpected.join(", ")}</>}
        </div>
      ))}

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

      {!schedulerOff && !screen.heartbeatStale && screen.nextAt && (
        <div className={a.note}>
          마지막 통과 <b>{beatValue(screen.lastOkAt, now)}</b> · 다음 점검{" "}
          <b>{screen.nextAt.toLocaleTimeString("ko-KR")}</b> 예정. 예정 시각은 스케줄러가
          적어 둔 값이라 주기를 바꿔도 이 화면이 따라옵니다.
        </div>
      )}
    </>
  );
}
