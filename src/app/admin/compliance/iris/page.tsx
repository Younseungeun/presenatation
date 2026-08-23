import { notFound } from "next/navigation";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import { readHeartbeat } from "@/server/schedulerHealth";
import {
  CANARY_INTERVAL_MS,
  CANARY_STALE_MS,
  getCanaryScreen,
} from "@/server/screeningCanaryRunner";
import { getScreeningAccuracy } from "@/server/complianceService";
import { countHardNegatives } from "@/server/retrainSignalService";
import { AdminHead } from "../../AdminHead";
import a from "../../admin.module.css";
import { IrisDetail } from "./IrisDetail";
import { RuleDetail } from "./RuleDetail";
import { AccuracyDetail } from "./AccuracyDetail";
import { RetrainGauge } from "../RetrainGauge";

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
  const [canary, schedulerBeat, accuracy, retrain] = await Promise.all([
    getCanaryScreen(prisma, now),
    readHeartbeat(prisma, now),
    getScreeningAccuracy(prisma),
    countHardNegatives(prisma),
  ]);

  return (
    <>
      <AdminHead title="검수 상세" sub="정확도 · IRIS · 검수 규칙" backHref="/admin/compliance" />
      <main className={a.page}>
        {/* **정확도가 맨 위** (2026-08-23 창업자 지시) — 계기판이 비율로 접어 둔 것을
            건수로 편다. 되짚으러 온 사람이 먼저 묻는 것은 "몇 건이냐"이고, 비율은
            표본이 작을 때 거짓말한다(4건 중 1건도 25%, 400건 중 100건도 25%) */}
        <AccuracyDetail summary={accuracy} />

        {/* 제목과 상태 칩은 IrisDetail 이 함께 그린다 — 상태를 아는 쪽이 제목도 쓴다
            (2026-08-23 창업자 지시로 물음표를 걷고 그 자리에 근무/결근 칩을 놓음) */}
        <IrisDetail />

        {/* **재학습 신호는 여기가 집이다** (2026-08-23 창업자 지시).
            평소 이 숫자는 며칠씩 안 움직여 계기판에서는 배경음이 된다. 되짚으러 오는
            이 화면에서는 반대로 **찾아보는 값**이고, 위 정확도(무엇을 틀렸나)와
            IRIS 신원(누가 틀렸나) 사이에 "다시 가르칠 때가 됐나"가 놓이는 것이 맞다.
            문턱에 닿으면 계기판에도 함께 뜬다 — 그때는 할 일이 생기기 때문이다 */}
        <RetrainGauge {...retrain} />

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
