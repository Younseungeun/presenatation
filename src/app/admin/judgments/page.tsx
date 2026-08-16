// ⚠ 디자인 보류 — 기능 검증용 최소 형태다. 화면을 다시 만들 때 지킬 불변은 docs/design-backlog.md에 있다

import Link from "next/link";
import { notFound } from "next/navigation";
import { ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { prisma } from "@/server/db";
import { getManualJudgmentQueue } from "@/server/manualJudgmentService";
import { getSessionUserId } from "@/server/session";
import { AppHeader } from "../../AppHeader";
import { EmptyState } from "../../EmptyState";
import { StatusChip } from "../../StatusChip";
import styles from "../../researcher/researcher.module.css";
import { ManualJudgeForm } from "./ManualJudgeForm";

export const dynamic = "force-dynamic";

// 운영자 판정 보류 큐: 자동 판정이 7일 이상 이월된 카드를 수동 판정한다.
// 운영자(role=OPERATOR)가 아니면 존재 자체를 숨긴다 (404).

export default async function AdminJudgmentsPage() {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const queue = await getManualJudgmentQueue(prisma);

  return (
    <>
      <AppHeader title="판정 보류 큐" backHref="/my" />
      <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <p className={styles.sub}>
            자동 판정이 7일 이상 이월된 카드입니다. 검증된 시세를 입력해 수동 판정하면
            점수·에스크로 정산까지 자동 경로와 동일하게 실행됩니다. 입력값과 사유는 감사
            기록으로 남습니다. <Link href="/admin/settlements">정산 지시서 →</Link>
          </p>
        </div>
      </div>

      {queue.length === 0 ? (
        <EmptyState compact glyph="inbox" title="보류 중인 카드가 없어요" />
      ) : (
        queue.map((entry) => (
          <div key={entry.cardId} className={styles.card}>
            <div className={styles.cardTop}>
              <div className={styles.cardTitle}>{entry.reportTitle}</div>
              <StatusChip status="UNDECIDABLE" label={`시한 경과 ${entry.staleDays}일`} />
            </div>
            <div className={styles.meta}>
              <span>{ASSET_CLASS_LABEL[entry.assetClass as AssetClass]}</span>
              <span>
                {entry.assetName} ({entry.ticker})
              </span>
              <span>{entry.researcherName}</span>
              <span>{entry.direction === "UP" ? "상승" : "하락"} 예측</span>
              <span>
                {entry.targetType === "RETURN_PCT"
                  ? `목표 ${entry.targetValue}%`
                  : `목표가 ${entry.targetValue.toLocaleString()}`}
              </span>
              <span>기준가 {entry.basePrice != null ? entry.basePrice.toLocaleString() : "미확정 (소급)"}</span>
              <span>시한 {new Date(entry.deadline).toLocaleDateString("ko-KR")}</span>
              <span>에스크로 {entry.heldPurchases}건</span>
              {entry.withdrawn && <span>철회됨</span>}
            </div>
            <ManualJudgeForm
              cardId={entry.cardId}
              targetType={entry.targetType}
              direction={entry.direction}
              needsBasePrice={entry.basePrice == null}
            />
          </div>
        ))
      )}
      </main>
    </>
  );
}
