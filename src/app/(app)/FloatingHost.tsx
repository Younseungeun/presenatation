import { prisma } from "@/server/db";
import { getBuyerPurchases } from "@/server/financeQueries";
import { getSessionUserId } from "@/server/session";
import { ActiveJudgmentPopup } from "./ActiveJudgmentPopup";
import { ComposeButton } from "./ComposeButton";
import { dday } from "@/lib/format";

// 하단에 떠 있는 것들의 데이터 공급자 — 레이아웃에 얹어 화면을 옮겨도 유지된다.
//
// 검증 중 팝업과 글쓰기 버튼을 **한 곳에서** 만든다. 각자 자기 호스트를 갖고 있으면
// 둘 다 뜨거나 둘 다 사라지는 상태를 막을 방법이 없다. 어느 쪽을 띄울지는 화면별 규칙
// (floatingSlot.ts)이 정하고, 두 컴포넌트가 같은 입력으로 같은 판단을 한다.

export async function FloatingHost() {
  const userId = await getSessionUserId();
  if (!userId) return null;

  const [purchases, researcher] = await Promise.all([
    getBuyerPurchases(prisma, userId),
    prisma.researcherProfile.findUnique({
      where: { userId },
      select: { id: true },
    }),
  ]);

  const active = purchases.filter((p) => !p.report.predictionCard?.judgment);
  const hasJudgment = active.length > 0;

  // 검증 중인 것 가운데 시한이 가장 가까운 카드
  const nextUp = active
    .filter((p) => p.report.predictionCard)
    .sort(
      (a, b) =>
        a.report.predictionCard!.deadline.getTime() -
        b.report.predictionCard!.deadline.getTime(),
    )[0];

  return (
    <>
      {hasJudgment && (
        <ActiveJudgmentPopup
          activeCount={active.length}
          nearestTitle={nextUp?.report.title ?? null}
          dday={nextUp ? dday(nextUp.report.predictionCard!.deadline, new Date()) : null}
          canCompose={researcher !== null}
        />
      )}
      {researcher && (
        <ComposeButton researcherId={researcher.id} hasJudgment={hasJudgment} />
      )}
    </>
  );
}
