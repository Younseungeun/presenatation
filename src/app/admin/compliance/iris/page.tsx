import { prisma } from "@/server/db";
import { readHeartbeat } from "@/server/schedulerHealth";
import {
  CANARY_INTERVAL_MS,
  CANARY_STALE_MS,
  getCanaryScreen,
} from "@/server/screeningCanaryRunner";
import { AdminHead } from "../../AdminHead";
import { SecHead } from "../../Why";
import a from "../../admin.module.css";
import { IrisDetail } from "./IrisDetail";
import { RuleDetail } from "./RuleDetail";

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
  const now = new Date();
  const [canary, schedulerBeat] = await Promise.all([
    getCanaryScreen(prisma, now),
    readHeartbeat(prisma, now),
  ]);

  return (
    <>
      <AdminHead title="검수 상세" sub="IRIS · 검수 규칙" backHref="/admin/compliance" />
      <main className={a.page}>
        <SecHead title="IRIS">
          <span>
            사이드카에 올라온 <b>학생 모델</b>입니다. 규칙이 못 잡는 <b>패러프레이즈</b>를
            메우고, 거절 권한은 없어 소견이 나와도 <b>보류까지</b>입니다.
          </span>
        </SecHead>
        <IrisDetail />

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
