import { prisma } from "@/server/db";
import { getBuyerPurchases } from "@/server/financeQueries";
import { getSessionUserId } from "@/server/session";
import { ActiveJudgmentPopup } from "./ActiveJudgmentPopup";
import { dday } from "./format";

// 진행 중인 판정 팝업의 데이터 공급자 — 레이아웃에 얹어 홈·리더보드·랭킹 어디서나 유지된다.
// (MY 화면에서 숨기고 지우기로 닫는 판단은 클라이언트 쪽 ActiveJudgmentPopup이 맡는다)
// 로그인 상태 + 검증 중인 구매가 있을 때만 렌더한다.

export async function ActiveJudgmentPopupHost() {
  const userId = await getSessionUserId();
  if (!userId) return null;

  const purchases = await getBuyerPurchases(prisma, userId);
  const active = purchases.filter((p) => !p.report.predictionCard?.judgment);
  if (active.length === 0) return null;

  // 검증 중인 것 가운데 시한이 가장 가까운 카드
  const nextUp = active
    .filter((p) => p.report.predictionCard)
    .sort(
      (a, b) =>
        a.report.predictionCard!.deadline.getTime() -
        b.report.predictionCard!.deadline.getTime(),
    )[0];

  return (
    <ActiveJudgmentPopup
      activeCount={active.length}
      nearestTitle={nextUp?.report.title ?? null}
      dday={nextUp ? dday(nextUp.report.predictionCard!.deadline, new Date()) : null}
    />
  );
}
