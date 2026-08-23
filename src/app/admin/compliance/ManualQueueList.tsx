import Link from "next/link";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import type { QueueEntry } from "@/server/manualJudgmentService";
import { ManualJudgeForm } from "../judgments/ManualJudgeForm";
import a from "../admin.module.css";

// 수동 판정 큐의 한 묶음 (시안 v3 rp-inst — 시세 때문에 / 특이사항).
//
// **왜 리포트 화면 안에 있나**: "시세를 못 구했다"와 "종목이 위험하다"는 둘 다 숫자를
// 봐야 끝나는 일이다. 전에는 /admin/judgments가 따로 있어 리포트를 보다 판정하러
// 화면을 옮겨야 했고, 옮기는 순간 방금 보던 맥락이 사라졌다.
//
// **목록은 얇은 줄, 판정은 열어서** (시안 그대로). 판정 폼을 전부 펼쳐 두면 카드가
// 길어져 "무엇부터 볼지"를 고를 수가 없다 — 고르는 일과 판정하는 일은 다른 일이다.
// 여는 상태는 URL(`?open=`)에 둔다: 새로고침·뒤로가기가 자연스럽고, 판정 후
// router.refresh()에서도 보던 자리가 유지된다.
//
// **줄에 붙는 칩은 둘**이다 — 왜 왔는지(사유)와 언제까지인지(상한). 이 큐에서 가장
// 중요한 숫자는 밀린 일수가 아니라 **남은 일수**다: 시한 후 14일이면 전액 환불로
// 닫히고, 그날이 지나면 맞혔을지도 모르는 리서처가 대금을 잃는다.

/** @근거 규칙 판정 파이프라인의 이월 상한과 같은 값 (sweepHardCapped) */
const HARD_CAP_DAYS = 14;

// 사유는 **볼 곳**을 말한다 — 같은 묶음 안에서도 무엇을 확인할지가 다르다
const REASON_LABEL: Record<string, string> = {
  CROSS_CHECK: "두 소스가 다른 값",
  IMPLAUSIBLE_QUOTE: "이상값 필터",
  REVERTED_SOURCE: "되돌린 카드",
};

export function ManualQueueList({
  entries,
  empty,
  openId,
  tab,
}: {
  entries: QueueEntry[];
  empty: string;
  /** 지금 펼쳐 둔 카드 — 나머지는 줄로 남는다 */
  openId?: string;
  tab: string;
}) {
  if (entries.length === 0) {
    return (
      <div className={a.empty}>
        <span className={a.dot} />
        {empty}
      </div>
    );
  }

  return (
    <>
      {entries.map((e) => {
        const left = HARD_CAP_DAYS - e.staleDays;
        // 상한이 코앞이면 붉다 — 지나면 되돌릴 수 없다
        const urgent = left <= 3;
        const stripe = urgent ? a.stripeNeg : a.stripeWarn;
        const title = `${e.assetName} ${e.direction === "UP" ? "상승" : "하락"} ${
          e.targetType === "RETURN_PCT"
            ? `${e.targetValue}%`
            : `· 목표 ${e.targetValue.toLocaleString()}`
        }`;
        const capChip = left > 0 ? `상한까지 D-${left}` : "상한 초과";

        if (e.cardId !== openId) {
          return (
            <Link
              key={e.cardId}
              href={`/admin/compliance?tab=${tab}&open=${e.cardId}`}
              className={`${a.lite} ${stripe}`}
            >
              <span className={a.liteMain}>
                <span className={a.liteName}>{title}</span>
                <span className={a.liteSub}>
                  {e.researcherName} · 구매 {e.heldPurchases}건 에스크로 · 시한{" "}
                  {new Date(e.deadline).toLocaleDateString("ko-KR")}
                </span>
                <span className={a.liteTags}>
                  {e.manualReason && (
                    <span className={a.chip}>{REASON_LABEL[e.manualReason] ?? e.manualReason}</span>
                  )}
                  <span className={a.chip}>{capChip}</span>
                  {e.withdrawn && <span className={a.chip}>철회됨</span>}
                </span>
              </span>
              <span className={a.liteRight}>
                <span className={a.go}>›</span>
              </span>
            </Link>
          );
        }

        // 펼친 것 — 목록에서 지우고 다시 그리는 것이 아니라 **자리에서 열린다**
        return (
          <div key={e.cardId} className={`${a.card} ${stripe}`}>
            <div className={a.row}>
              <span className={a.ttl}>{title}</span>
              <span className={`${a.chip} ${urgent ? a.chipNeg : a.chipWarn}`}>{capChip}</span>
            </div>
            <div className={a.meta}>
              <span>{e.researcherName}</span>
              <span>{ASSET_CLASS_LABEL[e.assetClass as AssetClass] ?? e.assetClass}</span>
              <span>{e.ticker}</span>
              <span>구매 {e.heldPurchases}건 에스크로</span>
              <span>시한 {new Date(e.deadline).toLocaleDateString("ko-KR")}</span>
              {e.manualReason && (
                <span className={a.chip}>{REASON_LABEL[e.manualReason] ?? e.manualReason}</span>
              )}
              {e.withdrawn && <span className={`${a.chip} ${a.chipNeg}`}>철회됨</span>}
            </div>
            <Link href={`/report/${e.reportId}`} className={a.xref} style={{ marginTop: 10 }}>
              <span>
                이용자가 보는 화면 그대로 열기 <small>— 종목·목표가·별점까지</small>
              </span>
              <span className={a.go}>›</span>
            </Link>
            <ManualJudgeForm
              cardId={e.cardId}
              targetType={e.targetType}
              direction={e.direction}
              needsBasePrice={e.basePrice === null}
            />
            <Link href={`/admin/compliance?tab=${tab}`} className={a.gate}>
              접기
            </Link>
          </div>
        );
      })}
    </>
  );
}
