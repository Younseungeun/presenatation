import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { readHeartbeat } from "@/server/schedulerHealth";
import {
  CANARY_INTERVAL_MS,
  CANARY_STALE_MS,
  getCanaryScreen,
} from "@/server/screeningCanaryRunner";
import { getScreeningAccuracy, getStudentRollbackStatus } from "@/server/complianceService";
import { isAutoShadowed } from "@/server/studentAutoShadow";
import { AdminHead } from "../../AdminHead";
import a from "../../admin.module.css";
import { IrisDetail } from "./IrisDetail";
import { StudentRollbackDetail } from "./StudentRollbackDetail";
import { RuleDetail } from "./RuleDetail";
import { AccuracyDetail } from "./AccuracyDetail";

/**
 * **검수 상세** — 계기판의 상자를 누르면 오는 자리.
 *
 * 상자에는 검수하는 것이 둘 있다(IRIS · 검수 규칙). 계기판은 매일 보는 화면이라 각각
 * 한 줄로 접어 두었고, 펼친 것이 여기다. **상자와 같은 순서로 나눈다** — 위에서 본
 * 순서가 여기서 바뀌면 어느 줄을 눌러 왔는지와 무관하게 다시 찾아야 한다.
 *
 * ── 값의 출처가 둘이라 렌더 방식도 둘이다 ──
 * · IRIS 는 **라우트에서 읽는다**(IrisDetail 주석) — 여기서 `usable()` 을 다시 부르면
 *   같은 질문의 답이 두 곳에서 나오고 언젠가 갈라진다.
 * · 검수 규칙은 **여기서 직접 잰다** — 실패 내용은 어디에도 저장되지 않아(알림 본문에만
 *   있고 사라진다) 박동을 읽는 것으로는 "어느 층이 죽었나"에 답할 수 없다.
 */
export default async function IrisPage() {
  /* **계기판과 같은 문을 쓴다.** 이 화면은 모델명·적재 지문·정확도·운영자 판정 건수를
     한자리에 모아 놓은 곳이라, 계기판보다 덜 잠겨 있으면 안 된다 — 접힌 것을 펼친
     화면이 원본보다 열려 있으면 자물쇠는 접힌 줄에만 걸린 셈이다.
     `notFound()` 인 것도 같은 이유다: `403` 은 "여기 뭔가 있다"를 알려 준다 */
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const now = new Date();
  const [canary, schedulerBeat, accuracy, rollback, autoShadowed] = await Promise.all([
    getCanaryScreen(prisma, now),
    readHeartbeat(prisma, now),
    getScreeningAccuracy(prisma),
    getStudentRollbackStatus(prisma),
    isAutoShadowed(prisma),
  ]);

  return (
    <>
      <AdminHead title="검수 상세" sub="정확도 · IRIS · 검수 규칙" backHref="/admin/compliance" />
      <main className={a.page}>
        {/* **정확도가 맨 위** (2026-08-23 창업자 지시) — 계기판이 비율로 접어 둔 것을
            건수로 편다. 되짚으러 온 사람이 먼저 묻는 것은 "몇 건이냐"이고, 비율은
            표본이 작을 때 거짓말한다(4건 중 1건도 25%, 400건 중 100건도 25%) */}
        <AccuracyDetail summary={accuracy} />

        {/* **판단 소요 시간 상자는 걷었다** (2026-08-24 창업자 지시).
            공백은 위 정확도 줄의 칩이 이미 말하고, 그쪽이 더 정확하다 — 상자는
            `승인만·최근 7일`을 세는데 칩은 `판정 전체`를 세어 **같은 화면에서 두 숫자가
            어긋났다**(상자 2건 vs 칩 3건). 한 화면이 같은 것을 두 번 말하면서 다르게
            말하면 둘 다 못 믿게 된다.
            ⚠ **함께 사라진 것: 유형별 판단 시간 중앙값**(26차 CC-1 피로도 감지 —
            "어떤 유형만 유독 빠르면 그 소견은 읽히지 않고 승인되고 있다"). 지금은 잰
            값이 0건이라 어차피 빈 표였지만, 시간이 쌓이면 **그 표가 다시 필요하다.**
            재는 쪽(`getDecisionSpeedByCategory`)과 시험은 그대로 살아 있고 그리는
            부품만 걷었다 — 되살릴 때는 `git show 0233743:src/app/admin/compliance/DecisionSpeedPanel.tsx`.
            그때는 공백 줄 없이 **중앙값 표만** 그린다(공백은 위 칩이 말한다) */}

        {/* 제목과 상태 칩은 IrisDetail 이 함께 그린다 — 상태를 아는 쪽이 제목도 쓴다
            (2026-08-23 창업자 지시로 물음표를 걷고 그 자리에 근무/결근 칩을 놓음) */}
        <IrisDetail />

        {/* **IRIS 순이익** — 계기판에서 이리로 내려왔다 (2026-08-29 창업자 지시).
            켜둘 값어치를 되짚어보는 값이라 상세가 집이고, 계기판에는 정지일 때만 칩으로 남는다 */}
        <StudentRollbackDetail rollback={rollback} autoShadowed={autoShadowed} />

        {/* **재학습 신호 게이지는 걷었다** (2026-08-29 창업자 지시). 진행 중 N/50 은
            안 변하는 숫자라 자리만 차지했다. 이제 문턱(50)을 넘는 순간에만 계기판의
            재학습 논의 자료 박스에 "재학습 추천" 칩으로 뜬다 — 상세엔 항목을 두지 않는다 */}

        <RuleDetail
          screen={canary}
          now={now}
          schedulerOff={schedulerBeat.stale}
          intervalMs={CANARY_INTERVAL_MS}
          staleMs={CANARY_STALE_MS}
        />
      </main>
    </>
  );
}
