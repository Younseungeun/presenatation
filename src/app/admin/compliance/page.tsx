import Link from "next/link";
import { notFound } from "next/navigation";
import {
  deadlineRisk,
  formatElapsed,
  HOLD_ATTENTION_HOURS,
  HOLD_OVERDUE_HOURS,
  holdUrgency,
  RISK_CATEGORY_LABEL,
  type Finding,
  type HoldUrgency,
  type RiskCategory,
} from "@/domain/compliance";
import {
  getPendingComplianceReviews,
  getPublishedReportsForOversight,
} from "@/server/complianceService";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import styles from "../../researcher/researcher.module.css";
import tabStyles from "../../market.module.css";
import { ResolveButton } from "./ResolveButton";

export const dynamic = "force-dynamic";

// 운영자 컴플라이언스 큐: 게시는 허용됐지만 검토가 필요한 건(WARN)과
// AI 검수가 실패해 확인이 필요한 건(UNAVAILABLE). 비운영자에게는 404.

function parseFindings(json: string): Finding[] {
  try {
    return JSON.parse(json) as Finding[];
  } catch {
    return [];
  }
}

// 대기가 길어진 건일수록 강하게 드러낸다 — 큐를 열었을 때 무엇부터 볼지가 바로 보여야 한다
const URGENCY_STYLE: Record<HoldUrgency, { accent: string; label: string }> = {
  OVERDUE: { accent: "var(--neg)", label: "지연" },
  ATTENTION: { accent: "var(--warn)", label: "주의" },
  NORMAL: { accent: "transparent", label: "" },
};

// 화면 분리: 판단 기준이 다른 건을 한 화면에서 섞어 보면 매번 "무엇을 봐야 하는 건인지"를
// 다시 파악해야 한다. 탭 상태는 URL(?tab=)에 두어 새로고침·공유·뒤로가기가 자연스럽게 동작한다.
const TAB_KEYS = ["content", "instrument", "published"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TABS: Record<TabKey, { label: string; description: string }> = {
  content: {
    label: "본문 검수 보류",
    description:
      "리포트 표현에서 확인이 필요한 소견이 나온 건입니다. 본문을 읽고 게시 승인 또는 반려를 결정해주세요.",
  },
  instrument: {
    label: "위험 종목 보류",
    description:
      "본문에는 문제가 없으나 종목 자체가 위험 신호를 받은 건입니다 — 거래소 투자주의·경고 지정, 상장폐지 가능성, 기준 미만 시가총액. 위법이 아니라 위험이므로 사람이 판단합니다. 정상적인 분석이면 승인하고, 구매자가 따라 들어가기에 부적절하면 반려해주세요.",
  },
  published: {
    label: "판매 중 리포트",
    description:
      "검토를 통과해 판매 중인 리포트입니다. 사후에 위반이 확인되면 강제 철회로 게시를 중단하고 구매자에게 전액 환불할 수 있습니다.",
  },
};

type PendingReview = Awaited<ReturnType<typeof getPendingComplianceReviews>>[number];

/**
 * 보류 사유가 종목 위험뿐인가.
 * 종목 위험과 본문 문제는 판단 기준이 다르다(종목을 팔아도 되나 vs 이 문장이 괜찮나).
 * 둘 다 있으면 본문 쪽이 더 무거우므로 내용 검수 항목으로 보낸다 — 한 건이 두 곳에
 * 뜨면 운영자가 같은 건을 두 번 처리하려다 혼란을 겪는다.
 */
function isInstrumentOnlyHold(findings: Finding[]): boolean {
  return (
    findings.length > 0 && findings.every((f) => f.category === "RISKY_INSTRUMENT")
  );
}

function urgencySummary(reviews: PendingReview[], now: Date) {
  return {
    overdue: reviews.filter((r) => holdUrgency(r.createdAt, now) === "OVERDUE").length,
    attention: reviews.filter((r) => holdUrgency(r.createdAt, now) === "ATTENTION").length,
  };
}

function UrgencyLine({ overdue, attention }: { overdue: number; attention: number }) {
  if (overdue === 0 && attention === 0) return null;
  return (
    <p className={styles.sub} style={{ marginTop: 6, fontWeight: 700 }}>
      {overdue > 0 && (
        <span style={{ color: "var(--neg)" }}>
          {HOLD_OVERDUE_HOURS}시간 초과 {overdue}건
        </span>
      )}
      {overdue > 0 && attention > 0 && " · "}
      {attention > 0 && (
        <span style={{ color: "var(--warn)" }}>
          {HOLD_ATTENTION_HOURS}시간 초과 {attention}건
        </span>
      )}{" "}
      — 대기가 긴 순으로 정렬되어 있습니다.
    </p>
  );
}

function ReviewCard({ review, now }: { review: PendingReview; now: Date }) {
  const findings = parseFindings(review.findingsJson);
  const researcher = review.report.researcher.user;
  const held = review.report.purchases;
  const heldAmountKrw = held.reduce((sum, p) => sum + p.amountKrw, 0);
  const urgency = holdUrgency(review.createdAt, now);
  const { accent, label: urgencyLabel } = URGENCY_STYLE[urgency];
  const risk = deadlineRisk(review.report.predictionCard?.deadline, now);

  return (
    <div
      className={styles.card}
      style={
        urgency === "NORMAL"
          ? undefined
          : {
              borderLeft: `4px solid ${accent}`,
              background: `color-mix(in srgb, ${accent} 5%, var(--bg))`,
            }
      }
    >
      <div className={styles.cardTop}>
        <div className={styles.cardTitle}>{review.report.title}</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {urgencyLabel && (
            <span
              className={`${styles.badge} ${
                urgency === "OVERDUE" ? styles.miss : styles.undecidable
              }`}
            >
              {urgencyLabel} · {formatElapsed(review.createdAt, now)}
            </span>
          )}
          <span
            className={`${styles.badge} ${
              review.decision === "UNAVAILABLE" ? styles.undecidable : styles.miss
            }`}
          >
            {review.report.status === "PENDING_REVIEW" ? "게시 대기" : "게시 중"} ·{" "}
            {/* 소견은 규칙에서도 나오므로 "AI"로 못 박지 않는다 (건별 출처는 아래 목록에 표시) */}
            {review.decision === "UNAVAILABLE"
              ? "검수 실패"
              : review.decision === "BLOCK"
                ? "위반 판정"
                : "확인 필요"}
          </span>
        </div>
      </div>
      <div className={styles.meta}>
        <span>{researcher.penName ?? researcher.email}</span>
        <span>검수 {review.reviewer}</span>
        <span>
          {new Date(review.createdAt).toLocaleString("ko-KR")} (
          {formatElapsed(review.createdAt, now)})
        </span>
        <span>
          {review.report.status === "PENDING_REVIEW"
            ? "게시 보류 — 판매 전"
            : review.report.status === "PUBLISHED"
              ? `판매 중 · 에스크로 ${held.length}건 ${heldAmountKrw.toLocaleString()}원`
              : "판매 종료"}
        </span>
        <Link href={`/report/${review.report.id}`}>본문 보기 →</Link>
      </div>

      {/* 승인은 그 시점 기준으로 컷오프를 다시 검증한다 — 시한이 임박하면 승인이 실패할 수 있다 */}
      {review.report.status === "PENDING_REVIEW" && risk !== "NONE" && (
        <p className={styles.hint} style={{ color: "var(--neg)", fontWeight: 600 }}>
          {risk === "PASSED"
            ? "검증 시한이 이미 지났습니다 — 승인해도 게시되지 않습니다. 반려해주세요."
            : "검증 시한이 48시간 내입니다 — 대기가 더 길어지면 최소 시한 규칙에 걸려 승인이 실패할 수 있습니다."}
        </p>
      )}

      {review.decision === "UNAVAILABLE" ? (
        <p className={styles.hint}>
          AI 검수가 실패해 결정적 규칙만 적용된 상태입니다. 본문을 직접 확인해주세요.
        </p>
      ) : (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13.5 }}>
          {findings.map((f, i) => (
            <li key={i} style={{ marginBottom: 6, color: "var(--text-weak)" }}>
              <span
                className={`${styles.badge} ${
                  f.severity === "BLOCK" ? styles.miss : styles.undecidable
                }`}
                style={{ marginRight: 6 }}
              >
                {f.severity === "BLOCK" ? "위반" : "확인 필요"}
              </span>
              <strong>{RISK_CATEGORY_LABEL[f.category as RiskCategory]}</strong> — {f.reason}
              <br />
              <span style={{ color: "var(--text-faint)" }}>&ldquo;{f.quote}&rdquo;</span>
            </li>
          ))}
        </ul>
      )}

      <ResolveButton
        reviewId={review.id}
        reportId={review.report.id}
        reportStatus={review.report.status}
        heldPurchases={held.length}
        heldAmountKrw={heldAmountKrw}
      />
    </div>
  );
}

export default async function AdminCompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const [pending, published] = await Promise.all([
    getPendingComplianceReviews(prisma),
    getPublishedReportsForOversight(prisma),
  ]);

  // 큐는 이미 오래된 순(= 대기가 긴 순)으로 온다. 정렬을 유지한 채 두 항목으로 나눈다.
  const now = new Date();
  const instrumentHolds = pending.filter((r) => isInstrumentOnlyHold(parseFindings(r.findingsJson)));
  const contentHolds = pending.filter((r) => !isInstrumentOnlyHold(parseFindings(r.findingsJson)));

  const sp = await searchParams;
  const tab: TabKey = TAB_KEYS.includes(sp.tab as TabKey) ? (sp.tab as TabKey) : "content";
  const counts: Record<TabKey, number> = {
    content: contentHolds.length,
    instrument: instrumentHolds.length,
    published: published.length,
  };

  return (
    <main className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1>컴플라이언스 검토</h1>
          <p className={styles.sub}>
            2단 검수(금지 표현 규칙 → AI 판단)로 결론이 나지 않아 <strong>게시가 보류된</strong>{" "}
            리포트입니다. 명백한 위반은 게시 시도 자체가 차단되므로 여기에 올라오지 않습니다.
            운영자가 <strong>게시 승인</strong> 또는 <strong>반려</strong>를 결정할 때까지 판매는
            시작되지 않습니다.{" "}
            <Link href="/admin/judgments">판정 보류 큐 →</Link>
          </p>
        </div>
      </div>

      {/* 보류 사유별로 화면을 분리한다 — 판단 기준이 다른 건을 한 화면에서 섞어 보지 않게 */}
      <div className={tabStyles.tabs}>
        {TAB_KEYS.map((key) => (
          <Link
            key={key}
            href={`/admin/compliance?tab=${key}`}
            className={`${tabStyles.tab} ${key === tab ? tabStyles.tabActive : ""}`}
          >
            {TABS[key].label}
            {counts[key] > 0 && ` (${counts[key]})`}
          </Link>
        ))}
      </div>

      <p className={styles.sub} style={{ marginTop: -10, marginBottom: 16 }}>
        {TABS[tab].description}
      </p>

      {tab === "content" && (
        <>
          <UrgencyLine {...urgencySummary(contentHolds, now)} />
          {contentHolds.length === 0 ? (
            <p className={styles.empty}>본문 검수로 보류된 건이 없습니다.</p>
          ) : (
            contentHolds.map((review) => <ReviewCard key={review.id} review={review} now={now} />)
          )}
        </>
      )}

      {tab === "instrument" && (
        <>
          <UrgencyLine {...urgencySummary(instrumentHolds, now)} />
          {instrumentHolds.length === 0 ? (
            <p className={styles.empty}>위험 종목으로 보류된 건이 없습니다.</p>
          ) : (
            instrumentHolds.map((review) => <ReviewCard key={review.id} review={review} now={now} />)
          )}
        </>
      )}

      {tab === "published" &&
        (published.length === 0 ? (
        <p className={styles.empty}>판매 중인 리포트가 없습니다.</p>
      ) : (
        published.map((report) => {
          const heldAmountKrw = report.purchases.reduce((sum, p) => sum + p.amountKrw, 0);
          const author = report.researcher.user;
          return (
            <div key={report.id} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.cardTitle}>{report.title}</div>
                <span className={`${styles.badge} ${styles.published}`}>판매 중</span>
              </div>
              <div className={styles.meta}>
                <span>{author.penName ?? author.email}</span>
                <span>
                  {report.publishedAt
                    ? new Date(report.publishedAt).toLocaleDateString("ko-KR")
                    : "-"}
                </span>
                <span>
                  에스크로 {report.purchases.length}건 {heldAmountKrw.toLocaleString()}원
                </span>
                <Link href={`/report/${report.id}`}>본문 보기 →</Link>
              </div>
              <ResolveButton
                reportId={report.id}
                reportStatus={report.status}
                heldPurchases={report.purchases.length}
                heldAmountKrw={heldAmountKrw}
              />
            </div>
          );
        })
        ))}
    </main>
  );
}
