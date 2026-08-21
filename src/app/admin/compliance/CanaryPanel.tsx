import type { CanaryScreen } from "@/server/screeningCanaryRunner";
import type { StatusTick } from "@/server/statusBand";
import { SCREENING_CANARY, type CanaryCase } from "@/domain/screeningCanary";
import { StatusBand } from "../StatusBand";
import { SecHead } from "../Why";
import a from "../admin.module.css";

// **검수가 지금 살아 있는가** (2026-08-21 사용자 지시).
//
// 정확도 패널이 "우리가 얼마나 잘 맞히나"라면 이 줄은 **"기계가 지금 도는가"**다.
// 성격이 달라 섞으면 안 된다 — 정확도는 지난 90일의 성적이고, 이건 지금 이 순간의 맥박이다.
//
// ── 왜 홈 띠지와 같은 부품인가 (2026-08-21 사용자 지시) ────────────
// 이 줄이 답하는 질문("기계가 지금 도는가")은 홈 띠지와 **같은 질문**이다. 같은 질문에
// 화면마다 다른 옷을 입히면 운영자가 자리마다 읽는 법을 새로 배워야 한다.
// 그래서 흉내내지 않고 `StatusBand`를 **그대로 부른다** — 베끼면 언젠가 한쪽만 고쳐지고,
// 그때 두 띠지는 같은 사실을 다르게 말하게 된다.
//
// ── 왜 기록을 읽지 않고 직접 재는가 ────────────────────────────
// 스케줄러가 매시간 돌려 성공 시각(박동)을 남기지만, **실패 내용은 어디에도 저장되지
// 않는다**(알림 본문에만 있고 사라진다). 박동만 읽으면 화면이 할 수 있는 말은
// "한 시간 전엔 괜찮았다"까지고, 정작 필요한 "어느 층이 죽었나"는 못 답한다.
// 여기서 직접 돌리는 비용은 정규식 6번 + 조회 2번이다(AI 호출 0, 종목명은 캐시).
//
// ── 층마다 한 칸인 이유 ────────────────────────────────────────
// 문항 하나만 두면 1층이 살아 있는 한 초록이라 **정작 이번에 죽은 4층을 못 본다.**
// 2026-08-20에 표기 회피 탐지가 통째로 꺼진 채 돌았는데(차단율 92% → 실제 0%)
// 예외도 경고도 없었고 시험 820건이 전부 초록이었다. 그 사고를 잡는 자리가 `훼손신호` 칸이다.

/**
 * 층 목록은 **문항에서 뽑는다 — 여기 적지 않는다** (2026-08-21 실제 사고).
 *
 * 처음에는 층 이름을 배열로 박아 뒀다. 서버가 `사전입력` 문항을 늘렸을 때
 * **화면은 5칸을 그대로 그렸고 타입 에러도 안 났다** — 별도 배열이라 union이 늘어도
 * 컴파일러가 볼 자리가 없다. 늘어난 층이 죽어도 띠지는 초록이었다는 뜻이다.
 *
 * 카나리아가 잡으려는 고장(**조용히 꺼진 채 초록**)을 카나리아 화면이 똑같이 저질렀다.
 * 목록을 두 곳에 두면 언젠가 갈라지므로, 한 곳에서 뽑는다.
 *
 * 등장 순서를 지킨다 — `SCREENING_CANARY`가 1층부터 차례로 적혀 있어 그 순서가 곧
 * 검수가 글을 훑는 순서다. 알파벳순으로 정렬하면 그 뜻이 사라진다.
 */
const LAYERS: readonly CanaryCase["layer"][] = [...new Set(SCREENING_CANARY.map((c) => c.layer))];

/**
 * 박동은 **얼마나 됐나**만 말한다 — 띠지 값은 한 눈에 잡혀야 해서 짧게 끊는다.
 * "한 번도 없음"과 "오래됨"을 한 낱말로 뭉치지 않는다: 둘 다 낡은 상태지만
 * 사람에게는 다른 사실이라(설치 직후인가, 돌던 것이 멈췄나) 처방도 다르다.
 */
function beatValue(from: Date | null, now: Date): string {
  if (!from) return "기록 없음";
  const min = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (min < 60) return `${min}분 전`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export function CanaryPanel({ screen, now }: { screen: CanaryScreen; now: Date }) {
  // 층별로 접는다 — 한 층에 문항이 둘인 곳이 있고(정상문항), 그 둘 중 하나만 죽어도
  // 그 층은 죽은 것이다
  const failedLayers = new Set(screen.failures.map((f) => f.layer));

  // **감시 장치는 살아 있어도 초록이다** (홈 띠지의 스케줄러·푸시 칸과 같은 규칙).
  // 이것들은 배경이 아니라 매번 확인해야 하는 정보다 — 꺼져 있으면 경보 자체가 안 오고,
  // 그러면 조용한 것과 사고가 없는 것이 구별되지 않는다
  const ticks: StatusTick[] = LAYERS.map((layer) => {
    const dead = failedLayers.has(layer);
    return { label: layer, value: dead ? "실패" : "통과", tone: dead ? "off" : "on" };
  });

  // 스케줄러가 도는가는 **다른 고장**이다 — 규칙은 멀쩡한데 자동 점검만 멈춰 있을 수
  // 있고, 그러면 다음 고장을 아무도 먼저 알려주지 않는다. 같은 띠에 태우되 칸은 나눈다
  ticks.push({
    label: "자동 점검",
    value: beatValue(screen.lastOkAt, now),
    tone: screen.heartbeatStale ? "off" : "on",
  });

  return (
    <>
      <SecHead title="검수 규칙">
        <span>
          정답이 정해진 문장 {screen.ran}개를 <b>운영과 같은 함수</b>에 통과시켜 잽니다 — 화면을
          열 때마다 지금 다시 재고, 스케줄러도 매시간 같은 것을 돌립니다.
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

      {/* 아래 줄들은 **지금 무엇이 사실인가**라 접지 않는다 (Why.tsx의 가름) */}

      {/* 죽은 층은 **무엇을 잃는지**를 그 자리에서 말한다 — 층 이름만으로는
          지금 무엇이 통과되고 있는지 알 수 없다 */}
      {screen.failures.map((f) => (
        <div key={f.id} className={`${a.note} ${a.noteNeg}`}>
          <b>[{f.layer}]</b> {f.meaning}
          {f.missing.length > 0 && <> — 못 잡음: {f.missing.join(", ")}</>}
          {f.unexpected.length > 0 && <> — 잘못 잡음: {f.unexpected.join(", ")}</>}
        </div>
      ))}

      {screen.heartbeatStale && (
        <div className={`${a.note} ${a.noteWarn}`}>
          {screen.lastOkAt
            ? "자동 점검이 하루 넘게 멈춰 있습니다."
            : "자동 점검이 한 번도 돌지 않았습니다."}{" "}
          위 칸들은 이 화면이 방금 직접 잰 값이라 지금은 맞지만, 화면을 닫아 두는 동안에는
          아무도 재지 않습니다 — 스케줄러를 확인하세요.
        </div>
      )}
    </>
  );
}
