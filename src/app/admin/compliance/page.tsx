// 리포트 — 관리자 5화면 중 ②. **끝내려면 본문·종목을 봐야 하는 일**이 여기 모인다.
//
// 시안 v3 문법으로 전부 옮겼다 (2026-08-19) — 겉(머리·확성기·탭)부터 안(카드·갈래·
// 버튼)까지 관리자 디자인 시스템(admin.module.css, 별칭 `a`) 하나만 쓴다.
// 이용자 화면의 스타일시트를 빌려 쓰던 것을 끊은 이유: 그쪽이 바뀌면 관리 화면이
// 같이 흔들리는데, 두 화면은 고쳐야 할 이유가 서로 다르다.

import Link from "next/link";
import { notFound } from "next/navigation";
import {
  deadlineRisk,
  autoScreenParticipation,
  missingScreeners,
  formatElapsedShort,
  requiresReviewAfterRejections,
  HOLD_ATTENTION_HOURS,
  HOLD_OVERDUE_HOURS,
  holdUrgency,
  RISK_CATEGORY_LABEL,
  type Finding,
  type HoldUrgency,
  type RiskCategory,
} from "@/domain/compliance";
import {
  ASSET_CLASSES,
  ASSET_CLASS_LABEL,
  TIER_NAME,
  TIERS,
  type Tier,
} from "@/domain/constants";
import { suggestPhrase } from "@/domain/learnedPhrases";
import { REVIEW_REJECTED_TITLE } from "@/domain/notice";
import type { AccuracySummary } from "@/domain/screeningAccuracy";
import { getLearnedPhraseStats } from "@/server/learnedPhraseService";
import { getManualJudgmentQueue } from "@/server/manualJudgmentService";
import { getPauseState } from "@/server/judgmentPause";
import {
  CANARY_INTERVAL_MS,
  CANARY_STALE_MS,
  getCanaryScreen,
} from "@/server/screeningCanaryRunner";
import { FlaggedReport } from "./FlaggedReport";
import { fromComplianceFindings } from "./flaggedFinding";
import { StudentValvePanel } from "./StudentValvePanel";
import { ManualQueueList } from "./ManualQueueList";
import { TeacherBatchCopy } from "./TeacherBatchCopy";
import {
  getTeacherAnswerPending,
  type TeacherAnswerPending,
} from "@/server/teacherAnswerQueue";
import { StudentShadowRelease } from "./StudentShadowRelease";
import {
  getPendingComplianceReviews,
  getPublishedReportsForOversight,
  getScreeningAccuracy,
  getStudentRollbackStatus,
  researcherSalesCounts,
} from "@/server/complianceService";
import { isAutoShadowed } from "@/server/studentAutoShadow";
import { studentMode } from "@/infra/compliance/studentClient";
import {
  getGraduationWatch,
  getRegressionCases,
  GRADUATION_MAX_PAIR_SIMILARITY,
  GRADUATION_MIN_CASES_PER_SIDE,
  GRADUATION_WATCH_DAYS,
} from "@/server/phraseGraduationService";
import { countHardNegatives } from "@/server/retrainSignalService";
import { getRescanQueue, type RescanQueueRow } from "@/server/phraseRescanService";
import { GraduateButton } from "./GraduateButton";
import { GraduationWatch } from "./GraduationWatch";
import { RegressionCases } from "./RegressionCases";
import { RetrainGauge } from "./RetrainGauge";
import { prisma } from "@/server/db";
import { getSessionUserId } from "@/server/session";
import a from "../admin.module.css";
import { getAdminQueues } from "@/server/adminQueues";
import { getAbuseReports, groupAbuseReports, REWARD_QUOTA } from "@/server/abuseReportService";
import { AbuseUserCaught } from "../AbuseUserCaught";
import { DirectMessage } from "../DirectMessage";
import { BuyerView } from "../BuyerView";
import { flaggedQuotes } from "../FlaggedBody";
import { getAbuseGroupDetail } from "@/server/abuseGroupDetail";
import { AdminHead } from "../AdminHead";
import { SecHead } from "../Why";
import { PhraseToggle } from "./PhraseToggle";
import { RewardNotice } from "./RewardNotice";
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
// **탭은 재료로 가른다** (시안 v3 rp-body / rp-inst): 본문은 '글', 종목·시세는 '숫자'.
// 전에는 넷이었는데(본문·위험 종목·판매 중·학습 표현) 뒤의 둘은 큐가 아니라 **도구**라
// 매일 세어야 할 것과 가끔 여는 것이 같은 줄에 섞여 있었다. 도구는 본문 탭 아래
// '도구' 묶음의 문으로 내려가고, 탭은 오늘 처리할 두 재료만 남는다.
const TAB_KEYS = ["body", "inst"] as const;
type TabKey = (typeof TAB_KEYS)[number];

/** 도구는 탭이 아니라 문이다 — URL은 유지해 링크·북마크가 깨지지 않는다 */
const TOOL_KEYS = ["published", "phrases"] as const;
type ToolKey = (typeof TOOL_KEYS)[number];
type PaneKey = TabKey | ToolKey;

// 탭 이름만 남긴다 — 시안에는 탭 설명 문단이 없다(묶음마다 물음표가 대신한다)
const TABS: Record<TabKey, { label: string }> = {
  body: { label: "본문" },
  inst: { label: "종목·시세" },
};

const TOOLS: Record<ToolKey, { label: string; description: string }> = {
  published: {
    label: "판매 중 리포트",
    description:
      "검토를 통과해 판매 중인 리포트입니다. 사후에 위반이 확인되면 강제 철회로 게시를 중단하고 구매자에게 전액 환불할 수 있습니다. 신고로 들어온 건은 본문 탭에서 처리하고, 여기는 신고 없이 직접 내려야 할 때의 문입니다.",
  },
  // **화면 문구는 `운영자 사전`, URL은 `phrases`** (3회차 C-1 → 회신 3호 확정).
  // 코드 식별자와 화면 이름을 분리하는 것은 이 저장소의 관례다 (카드지갑/cart 와 같은 결정) —
  // 북마크·링크가 깨지지 않는 쪽이 이름을 맞추는 것보다 값어치가 크다
  phrases: {
    label: "운영자 사전",
    description:
      "반려·철회하며 등록한 표현입니다. 리서처의 작성 화면에서 실시간으로 경고를 띄우고, 게시 시 검수에도 같은 표현이 적용됩니다. " +
      // **여기서 하는 일은 코드 규칙에 잡을 것을 더하는 것**이지 별개 검사기를 만드는
      // 것이 아니다 — 사전 항목은 코드 패턴과 같은 배열에 들어가 같은 층·같은 가드를
      // 지난다(applyRules 의 activeRules). 다만 **심각도만 갈린다**: 즉시 거절은
      // ① 문맥 조건을 코드로 적을 수 있고 ② 대조군에서 오탐 0 이 측정됐고
      // ③ 코드 배포를 거친 패턴에만 있다 (회신 7호 §2 확정). 사전은 문자열 하나라
      // "어떤 문맥에서 위반인지"를 적을 자리가 없고, 운영 중 사람 손으로 바뀐다.
      "여기서 더하는 것은 코드 규칙이 잡을 표현이고, 별개의 검사기가 아닙니다 — 같은 층을 같은 순서로 지납니다. 다만 사전 항목은 언제나 보류까지입니다. 즉시 거절은 문맥 조건을 코드로 적고 대조군 검사를 통과한 패턴에만, 코드 배포로만 생깁니다. " +
      "걸린 횟수 대비 실제 반려 비율이 낮으면 오탐을 내고 있다는 뜻이므로 비활성화해주세요.",
  },
};

// 정렬 기준. 기본은 대기 시간 — 보류가 길어질수록 리서처가 판매를 못 하기 때문.
// 나머지는 운영자가 다른 관점으로 훑고 싶을 때 쓴다.
const SORT_KEYS = ["wait", "deadline", "tier", "sales"] as const;
type SortKey = (typeof SORT_KEYS)[number];

const SORT_LABEL: Record<SortKey, string> = {
  wait: "대기 오래된 순",
  deadline: "검증 시한 임박 순",
  tier: "리서처 등급 높은 순",
  sales: "판매량 많은 순",
};

/** 판매 중 탭은 대기 개념이 없으므로 최신 게시 순이 기본 */
const PUBLISHED_SORT_LABEL: Record<SortKey, string> = {
  ...SORT_LABEL,
  wait: "최근 게시 순",
};

const tierRank = (tier: string) => TIERS.indexOf(tier as Tier);

type PendingReview = Awaited<ReturnType<typeof getPendingComplianceReviews>>[number];
type PublishedReport = Awaited<ReturnType<typeof getPublishedReportsForOversight>>[number];

/** 시한이 없는 카드는 항상 뒤로 (정렬에서 튀지 않게) */
const deadlineValue = (d: Date | null | undefined) => d?.getTime() ?? Number.MAX_SAFE_INTEGER;

function sortPending(
  reviews: PendingReview[],
  sort: SortKey,
  sales: Map<string, number>,
): PendingReview[] {
  const rows = [...reviews];
  switch (sort) {
    case "deadline":
      return rows.sort(
        (a, b) =>
          deadlineValue(a.report.predictionCard?.deadline) -
          deadlineValue(b.report.predictionCard?.deadline),
      );
    case "tier":
      return rows.sort((a, b) => tierRank(b.report.researcher.tier) - tierRank(a.report.researcher.tier));
    case "sales":
      return rows.sort(
        (a, b) =>
          (sales.get(b.report.researcher.id) ?? 0) - (sales.get(a.report.researcher.id) ?? 0),
      );
    default: // wait — 쿼리가 이미 오래된 순으로 준다
      return rows;
  }
}

function sortPublished(reports: PublishedReport[], sort: SortKey): PublishedReport[] {
  const rows = [...reports];
  switch (sort) {
    case "deadline":
      return rows.sort(
        (a, b) =>
          deadlineValue(a.predictionCard?.deadline) - deadlineValue(b.predictionCard?.deadline),
      );
    case "tier":
      return rows.sort((a, b) => tierRank(b.researcher.tier) - tierRank(a.researcher.tier));
    case "sales":
      return rows.sort((a, b) => b._count.purchases - a._count.purchases);
    default: // 쿼리가 이미 최신 게시 순으로 준다
      return rows;
  }
}

// 정렬은 순서를 바꾸는 것이지 후보를 줄이는 것이 아니다 — 그래서 탭(무엇을 보나)과
// 형태를 다르게 둔다: 탭은 채워진 알약, 정렬은 테두리 칩
function SortBar({ tab, sort }: { tab: PaneKey; sort: SortKey }) {
  const labels = tab === "published" ? PUBLISHED_SORT_LABEL : SORT_LABEL;
  return (
    <div className={a.chips} style={{ margin: "0 0 14px" }}>
      {SORT_KEYS.map((key) => (
        <Link
          key={key}
          href={`/admin/compliance?tab=${tab}&sort=${key}`}
          className={`${a.pick} ${key === sort ? a.pickOn : ""}`}
        >
          {labels[key]}
        </Link>
      ))}
    </div>
  );
}

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

/**
 * 보상 안내 대기를 **리포트 단위로** 묶는다 (시안 rp-4).
 *
 * 한 리포트가 확인되면 그 신고자 전원에게 같은 말을 보낸다 — 사람마다 줄을 두면
 * 같은 문장을 세 번 쓰게 되고, 세 번 쓰는 일은 언젠가 두 번만 쓰게 된다.
 * 칩의 날짜는 **가장 오래 기다린 사람**의 것이다: 묶음이 얼마나 방치됐는지를
 * 평균이 아니라 최악이 말해야 한다.
 */
function groupRewardPending(
  rows: { id: string; reporterName: string; reportId: string | null; reportTitle: string | null; createdAt: Date }[],
  now: Date,
) {
  const byReport = new Map<
    string,
    { reportId: string; title: string; reporters: { id: string; name: string }[]; oldest: Date }
  >();
  for (const r of rows) {
    if (!r.reportId) continue;
    const g = byReport.get(r.reportId) ?? {
      reportId: r.reportId,
      title: r.reportTitle ?? "리포트 없음",
      reporters: [],
      oldest: r.createdAt,
    };
    g.reporters.push({ id: r.id, name: r.reporterName });
    if (r.createdAt < g.oldest) g.oldest = r.createdAt;
    byReport.set(r.reportId, g);
  }
  return [...byReport.values()].map((g) => ({
    ...g,
    waitedDays: Math.max(1, Math.floor((now.getTime() - g.oldest.getTime()) / 86_400_000)),
  }));
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
    <div className={a.auto}>
      <span className={a.chip}>대기</span>
      <span>
        {overdue > 0 && (
          <b style={{ color: "var(--neg)" }}>
            {HOLD_OVERDUE_HOURS}시간 초과 {overdue}건
          </b>
        )}
        {overdue > 0 && attention > 0 && " · "}
        {attention > 0 && (
          <b style={{ color: "var(--warn)" }}>
            {HOLD_ATTENTION_HOURS}시간 초과 {attention}건
          </b>
        )}{" "}
        — 대기가 긴 순으로 정렬되어 있습니다. <b>결정이 날 때까지 리서처는 판매를 못 합니다.</b>
      </span>
    </div>
  );
}

/**
 * 검수 보류 한 건 — **줄과 상세를 나눈다** (2026-08-20 사용자 지시).
 *
 * 신고 카드(AbuseUserCaught)와 같은 문법이다: 목록은 **훑는 것**이고 상세는 **읽는 것**.
 * 전부 펼쳐 두면 보류 세 건만으로도 화면이 소견·인용·폼으로 가득 차, "오늘 몇 건인가"가
 * 스크롤 길이가 된다 — 고르는 일과 판단하는 일은 다른 일이라 형태도 달라야 한다.
 *
 * 펼침은 URL(`?open=`)에 둔다. 승인·반려를 내리면 화면이 새로 그려지는데 상태를
 * 컴포넌트가 들고 있으면 그때 접혀 버려 "내가 방금 뭘 눌렀지"가 된다.
 */
/**
 * **교사 답 대기 줄과 질의 실태** (18차 V-3 · V-7).
 *
 * **박스 하나로 줄였다** (2026-08-27 창업자 지시): 판정을 내릴 때 케이스별 질문지가
 * 자동으로 저장되고, 여기서는 그것을 **전부 한 번에 복사**만 한다. 답을 다시 붙여넣어
 * 기록하는 흐름은 없앴다 — 재학습·사전 표현 등록은 창업자가 그 답을 보고 **코드로 직접**
 * 반영하기 때문. 그래서 이 패널이 하는 일은 "쌓인 질문지를 걷어 주는 것" 하나다.
 */
function TeacherRelayPanel({ pending }: { pending: TeacherAnswerPending[] }) {
  // 쌓인 질문지가 없으면 그리지 않는다 — 0건짜리 계기판은 장식이다
  if (pending.length === 0) return null;

  return (
    <section
      style={{
        margin: "0 16px 12px",
        padding: "12px 14px",
        borderRadius: 10,
        border: "1px solid var(--line)",
        background: "transparent",
        fontSize: 13,
        color: "var(--text-weak)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div>
          <strong style={{ color: "var(--text)" }}>재학습 논의 자료</strong>{" "}
          <b style={{ color: "var(--text)" }}>{pending.length}건</b>
        </div>
        <TeacherBatchCopy />
      </div>
    </section>
  );
}

/** @근거 계약 — 회신 8호 §2-b 확정: 코드 이식 후보의 네 조건 */
const PROMOTION_MIN_MATCHES = 30;
const PROMOTION_MIN_RESEARCHERS = 5;
const PROMOTION_MIN_AGE_DAYS = 30;
/** 리서처 수 집계가 시작된 날 — 그 전 매칭은 셀 수 없어 0 이다 (기록 이전 ≠ 한 사람) */
const HIT_LOG_SINCE = "2026-08-22";

/**
 * **코드 이식 후보** — 즉시 거절로 가는 유일한 길의 문 앞.
 *
 * 사전 항목은 아무리 정확해져도 저절로 세지지 않는다(회신 7호 §3, 영구 확정). 대신
 * 실적이 쌓이면 **코드 패턴으로 이식할 후보**가 된다 — 문맥 조건을 적고, 대조군에서
 * 오탐 0 을 재고, 배포한다.
 *
 * ── 네 조건을 모두 그린다 (하나만 빠져도 배지가 거짓말이 된다) ──
 * 특히 **서로 다른 리서처 수**가 이 배지의 값어치다. 그것 없이 "30회 · 100%" 만 보면
 * 한 사람이 같은 문구를 30번 써서 만든 30회가 후보로 뜨는데, 즉시 거절이 지키는 상대는
 * "지금 리서처"가 아니라 "아직 안 온 정상 문장"이다.
 *
 * ── 못 채운 조건을 감추지 않는다 ──
 * 채운 것만 보여주면 "거의 다 됐다"로 읽힌다. 넷을 다 늘어놓고 못 채운 것을 흐리게
 * 그린다 — 무엇이 남았는지가 이 줄의 정보다.
 */
function PromotionCandidate({
  p,
  now,
}: {
  p: { matchCount: number; confirmedCount: number; createdAt: Date; distinctResearcherCount: number };
  now: Date;
}) {
  const ageDays = Math.floor((now.getTime() - p.createdAt.getTime()) / 86_400_000);
  const checks = [
    { ok: p.matchCount >= PROMOTION_MIN_MATCHES, label: `걸림 ${p.matchCount}/${PROMOTION_MIN_MATCHES}` },
    {
      ok: p.matchCount > 0 && p.confirmedCount === p.matchCount,
      label: p.matchCount > 0 ? `확정 ${Math.round((p.confirmedCount / p.matchCount) * 100)}%/100%` : "확정 —",
    },
    { ok: ageDays >= PROMOTION_MIN_AGE_DAYS, label: `${ageDays}/${PROMOTION_MIN_AGE_DAYS}일` },
    {
      ok: p.distinctResearcherCount >= PROMOTION_MIN_RESEARCHERS,
      label: `리서처 ${p.distinctResearcherCount}/${PROMOTION_MIN_RESEARCHERS}명`,
    },
  ];
  const done = checks.every((c) => c.ok);

  // 아직 한 번도 안 걸린 항목에는 그리지 않는다 — 갓 등록한 카드마다 0/30 이 붙으면
  // 목록이 진행 막대로 덮이고, 그 줄이 말하는 것은 "아무 일도 없었다"뿐이다
  if (p.matchCount === 0) return null;

  return (
    <div className={a.meta}>
      <span style={{ color: done ? "var(--text)" : "var(--text-faint)", fontWeight: done ? 600 : 400 }}>
        {done ? "코드 규칙 후보" : "코드 규칙 후보까지"}
      </span>
      {checks.map((c) => (
        <span key={c.label} style={{ color: c.ok ? "var(--text-weak)" : "var(--text-faint)" }}>
          {c.ok ? "✓" : "·"} {c.label}
        </span>
      ))}
      {/* **0 명은 "한 사람"이 아니라 "기록 이전"이다** (회신 8호 §1) — 이 구별을 안 적으면
          옛 항목이 전부 "리서처 1명 미만"으로 읽혀 부당하게 후보에서 밀린다 */}
      {p.distinctResearcherCount === 0 && p.matchCount > 0 && (
        <span>리서처 수는 {HIT_LOG_SINCE} 이후 매칭부터 셉니다</span>
      )}
    </div>
  );
}

/**
 * **왜 이 건이 큐에 왔는가** — 평소와 다른 이유일 때만 그린다 (2026-08-24 창업자 지시).
 *
 * ── 걷어낸 것: `확인 필요` ────────────────────────────────────────
 * 예전에는 `decision` 을 세 문구로 옮겨 언제나 칩을 그렸고, 그중 `확인 필요`가
 * **큐 16건 중 14건**이었다. 그런데 큐에 있다는 것 자체가 이미 "확인이 필요하다"는
 * 뜻이고, 소견이 있는 건은 바로 옆에 **유형 칩**(수익 보장·비현실적 예측 크기…)이
 * 붙어 "무엇 때문에"까지 말한다. `확인 필요`는 그 앞에서 같은 말을 한 번 더 했다.
 *
 * ── 대신 채운 것: `반려 3회` ──────────────────────────────────────
 * `확인 필요` 가 **엉뚱한 답을 하던 자리**가 하나 있었다: 소견이 0건인데 큐에 온 건.
 * 반려가 누적돼 자동 통과 경로가 닫힌 것인데(REPUBLISH_REVIEW_THRESHOLD), 소견이
 * 없으니 유형 칩도 없어서 **왜 여기 있는지 화면 어디에도 없었다.** 판단 기준부터
 * 다른 건이다 — "이 문장이 위반인가"가 아니라 "이 사람이 규칙을 더듬고 있나"다.
 *
 * 남는 규칙: **칩이 붙은 카드는 전부 평소와 다른 이유로 온 건**이라, 훑다가 걸리는
 * 것 자체가 신호가 된다.
 */
/**
 * **`검수 모델이 세운 것` 을 넷으로 가른다** (2026-08-25 창업자 확정).
 *
 * 가르는 기준은 "무엇에 걸렸나"가 아니라 **운영자가 무엇을 하는가**다:
 *
 *   판매 중    이미 팔린 글을 내릴지 → 별도 목록(재검수 결과)이 그린다
 *   검수 실패  검수가 온전치 않다 → 모델이 못 본 것을 **내가 대신 읽는다**
 *   반려 3회   소견이 없는데 왔다 → 글이 아니라 **재제출 이력**을 본다
 *   검수 성공  검수가 온전했고 소견이 있다 → 그 **소견이 맞는지** 본다
 *
 * ── 겹칠 때는 `검수 실패` 가 이긴다 ────────────────────────────────
 * 소견 0건 + 반려 3회 + `IRIS !` 인 건이 실제로 있다. 그것을 `반려 3회` 로 넣으면
 * **"소견이 0건"이라는 사실이 앞에 서는데, IRIS 가 안 돌았으면 그 0건을 못 믿는다** —
 * 깨끗해서 0건인지 안 봐서 0건인지 구별이 안 된다. 그 불확실이 더 무거우므로 위로 올린다.
 */
type HoldGroup = "fail" | "rejected" | "ok";

const HOLD_GROUP_NOTE: Record<HoldGroup, string> = {
  fail: "규칙 엔진이나 IRIS 가 판정에 참여하지 못했습니다 — 모델이 못 본 부분을 직접 읽어야 합니다.",
  rejected: "검수 소견은 없습니다. 반려가 쌓여 자동 게시 경로가 닫힌 건이라, 볼 것은 본문이 아니라 재제출 이력입니다.",
  ok: "검수가 온전히 돌았고 소견이 나와 멈췄습니다. 그 소견이 맞는지 보시면 됩니다.",
};

function holdGroup(review: {
  reviewer: string;
  findingsJson: string;
  report: { rejectionCount: number };
}): HoldGroup {
  if (missingScreeners(review.reviewer) !== null) return "fail";
  let findingCount = 0;
  try {
    findingCount = (JSON.parse(review.findingsJson) as unknown[]).length;
  } catch {
    /* 깨진 JSON 은 소견 0 으로 본다 — 아래 분기가 `검수 성공` 으로 보내지 않게 */
  }
  if (findingCount === 0 && requiresReviewAfterRejections(review.report.rejectionCount)) {
    return "rejected";
  }
  return "ok";
}

/**
 * 재검수 한 줄 — **판정 카드가 아니라 목록의 줄**이다.
 *
 * 여기서 승인·반려를 받지 않는다. 이 건들은 이미 게시된 글이라 할 수 있는 일이
 * "그냥 두기"와 "강제 철회" 둘뿐인데, 철회는 전액 환불 + 정산 0 + 점수 0 이라
 * **판매 중 리포트 탭의 기존 경로**를 그대로 타야 한다 — 처분 화면이 두 벌이 되면
 * 확인 문구·2인 승인 같은 관문이 한쪽에만 붙는다.
 * 그래서 이 줄이 하는 일은 **어느 글을 봐야 하는지 알려주고 그 자리로 보내는 것**뿐이다.
 */
function RescanRow({ hit, now }: { hit: RescanQueueRow; now: Date }) {
  return (
    <Link href={`/admin/compliance?tab=published&focus=${hit.reportId}`} className={a.lite}>
      <span className={a.liteMain}>
        <span className={a.liteName}>{hit.reportTitle}</span>
        <span className={a.liteSub}>
          {hit.researcherName} · {formatElapsedShort(hit.createdAt, now)}
        </span>
        {/* **걸린 문장이 이 줄의 전부다** — 운영자가 자기 눈으로 판단할 유일한 재료라
            제목보다 이쪽이 먼저 읽혀야 한다 */}
        <span className={a.quote}>&ldquo;{hit.quote}&rdquo;</span>
        <span className={a.liteTags}>
          <span className={a.chip}>{hit.phrase}</span>
          <span className={a.chip}>{RISK_CATEGORY_LABEL[hit.category] ?? hit.category}</span>
          {hit.heldPurchases > 0 && (
            <span className={`${a.chip} ${a.chipNeg}`}>에스크로 {hit.heldPurchases}건</span>
          )}
        </span>
      </span>
      <span className={a.liteRight}>
        <span className={a.go}>›</span>
      </span>
    </Link>
  );
}

/** 묶음 머리 — 절 제목(`SecHead`)보다 한 단 작다. 같은 절 안의 갈래이기 때문 */
function SubHead({ title, count, note }: { title: string; count: number; note: string }) {
  return (
    <div className={a.subhead}>
      <div className={a.subheadTop}>
        <b>{title}</b>
        <span className={a.n}>{count}</span>
      </div>
      <span className={a.subheadNote}>{note}</span>
    </div>
  );
}

function QueueReasonChip({
  decision,
  rejectionCount,
}: {
  decision: string;
  rejectionCount: number;
}) {
  /* **`검수 실패` 칩은 걷었다** (2026-08-25 창업자 지적 — 겹친다).
     `UNAVAILABLE` 은 "IRIS 를 부르다 실패해 규칙만 판정했다"는 뜻인데, 그것은
     `AutoScreenChip` 이 `IRIS !` 로 이미 말한다. 같은 사실을 두 칩이 나눠 말하면
     운영자가 둘을 다른 고장으로 읽는다 — 실제로 한 카드에 나란히 붙어 있었다. */
  if (decision === "BLOCK") {
    return (
      <span className={`${a.chip} ${a.chipNeg}`} title="즉시 거절 수준의 소견이 나왔습니다.">
        위반 판정
      </span>
    );
  }
  // **소견이 있어서 온 건에는 아무것도 안 그린다** — 옆 유형 칩이 이미 말한다
  if (!requiresReviewAfterRejections(rejectionCount)) return null;
  return (
    <span
      className={`${a.chip} ${a.chipWarn}`}
      title={`반려 ${rejectionCount}회 — 검수를 통과해도 자동 게시하지 않습니다. 문구만 바꿔 재제출하며 검수 경계를 더듬는 것을 막는 장치입니다. 볼 것이 문장이 아니라 재제출 이력입니다.`}
    >
      반려 {rejectionCount}회
    </span>
  );
}

/**
 * **자동 검수에 AI 가 빠졌다는 사실을 칩으로 말한다** (2026-08-24 창업자 지시).
 *
 * 예전에는 카드 안에 문장으로 적혀 있었다 — "AI 검수가 실패해 결정적 규칙만 적용된
 * 상태입니다". 그런데 그 문장은 **카드를 펼쳐야** 보이고, 다른 안내문과 같은 무게라
 * 훑을 때 걸리지 않았다. 큐에서 **무엇부터 볼지 고르는 순간**에 필요한 정보라
 * 접힌 줄에도 서야 한다.
 *
 * 정상(규칙 + IRIS)에는 아무것도 그리지 않는다 — 잘 돈 것은 사건이 아니다.
 */
function AutoScreenChip({ reviewer }: { reviewer: string }) {
  const missing = missingScreeners(reviewer);
  if (missing === null) return null; // 둘 다 참여 = 정상. 잘 돈 것은 사건이 아니다

  const { aiMissing } = autoScreenParticipation(reviewer);
  const why =
    missing === "RULE+IRIS"
      ? "규칙 엔진과 IRIS 가 **둘 다** 판정하지 않았습니다 — 사실상 아무도 안 본 건입니다. 본문을 처음부터 직접 읽어 주세요."
      : missing === "IRIS"
        ? aiMissing === "OUTAGE"
          ? "IRIS 를 부르다 실패해 규칙 엔진만 판정했습니다. 규칙이 못 잡는 패러프레이즈(같은 뜻 다른 말)는 걸러지지 않았습니다."
          : "IRIS 가 참여하지 않은 채 규칙 엔진만 판정했습니다. 규칙이 못 잡는 패러프레이즈는 걸러지지 않았습니다."
        : "규칙 엔진이 판정하지 않았습니다 — 즉시 거절 권한이 있는 유일한 검사기가 빠진 상태입니다.";

  return (
    <span
      /* 둘 다 빠진 건이 가장 무겁다 — 하나만 빠진 것과 색을 나눈다 */
      className={`${a.chip} ${missing === "RULE+IRIS" ? a.chipNeg : a.chipWarn}`}
      title={why.replace(/\*\*/g, "")}
    >
      {missing} !
    </span>
  );
}

function ReviewCard({
  review,
  now,
  open,
  tab,
  sort,
}: {
  review: PendingReview;
  now: Date;
  open: boolean;
  tab: string;
  sort: SortKey;
}) {
  const findings = parseFindings(review.findingsJson);
  const researcher = review.report.researcher.user;
  const held = review.report.purchases;
  const heldAmountKrw = held.reduce((sum, p) => sum + p.amountKrw, 0);
  const urgency = holdUrgency(review.createdAt, now);
  const { label: urgencyLabel } = URGENCY_STYLE[urgency];
  const risk = deadlineRisk(review.report.predictionCard?.deadline, now);

  const pendingPublish = review.report.status === "PENDING_REVIEW";
  // 색은 **급함 한 축**이다: 지연이면 빨강, 주의면 노랑, 그 외에는 띠를 그리지 않는다.
  // 배경까지 물들이지 않는다 — 카드가 옅은 색으로 차면 그 안의 알약이 안 읽힌다
  const stripe =
    urgency === "OVERDUE" ? a.stripeNeg : urgency === "ATTENTION" ? a.stripeWarn : "";
  const base = `/admin/compliance?tab=${tab}&sort=${sort}`;

  if (!open) {
    // 줄에 싣는 것은 **고를 때 쓰는 것**뿐이다 — 누구 글인가, 얼마나 기다렸나,
    // 무엇으로 걸렸나. 소견 인용과 판단 폼은 펼친 뒤에 온다
    return (
      <Link
        href={`${base}&open=${review.id}`}
        className={`${a.lite} ${stripe}`}
        scroll={false}
      >
        <span className={a.liteMain}>
          <span className={a.liteName}>{review.report.title}</span>
          {/* 등급은 **표시 이름**으로 (TIER_NAME) — 줄 목록에서 옆 신고 카드가
              `무표기`라고 적는데 여기만 `BRONZE`면 다른 축의 값처럼 읽힌다.
              시간은 짧은 꼴(formatElapsedShort)로 — 이 줄은 훑는 자리다 */}
          <span className={a.liteSub}>
            {researcher.penName ?? researcher.email} ·{" "}
            {TIER_NAME[review.report.researcher.tier as Tier] ?? review.report.researcher.tier} ·{" "}
            {/* 짧은 꼴로 — 이 줄은 훑는 자리다. 정확한 값은 펼치면 나온다 */}
            {formatElapsedShort(review.createdAt, now)}
          </span>
          <span className={a.liteTags}>
            <QueueReasonChip
              decision={review.decision}
              rejectionCount={review.report.rejectionCount}
            />
            {/* **고를 때 쓰는 정보다** — 규칙만 돈 건은 사람이 대신 봐야 해서 할 일의
                무게가 다르다. 펼쳐야 보이면 고르는 순간에 못 쓴다 */}
            <AutoScreenChip reviewer={review.reviewer} />
            {/* 무엇으로 걸렸는지 — 유형이 곧 "무엇을 볼 것인가"다 */}
            {[...new Set(findings.map((f) => f.category))].slice(0, 2).map((c) => (
              <span key={c} className={a.chip}>
                {RISK_CATEGORY_LABEL[c as RiskCategory] ?? c}
              </span>
            ))}
            {/* **`판매 전` 은 걷었다** (2026-08-25 창업자 지적 — 큐에서 언제나 참이다).
                보류 큐가 담는 것은 `needsOperatorReview` 인 건이고, 그 표식은 게시
                관문에서만 붙으므로 리포트 상태가 언제나 `PENDING_REVIEW` 다(실측 15/15).
                판매 중 리포트는 다른 탭·다른 부품이 그린다.
                **다만 돈이 걸려 있으면 그린다** — 그때는 처분의 무게가 달라지고, 그건
                평소와 다른 사실이다. 구조상 오지 않을 자리지만, 오면 반드시 보여야 한다 */}
            {held.length > 0 && (
              <span className={`${a.chip} ${a.chipNeg}`}>에스크로 {held.length}건</span>
            )}
          </span>
        </span>
        <span className={a.liteRight}>
          {urgencyLabel && (
            <span className={`${a.chip} ${urgency === "OVERDUE" ? a.chipNeg : a.chipWarn}`}>
              {urgencyLabel}
            </span>
          )}
          <span className={a.go}>›</span>
        </span>
      </Link>
    );
  }

  return (
    <div className={`${a.card} ${stripe}`}>
      <div className={a.row}>
        <span className={a.ttl}>{review.report.title}</span>
        <span className={a.liteRight}>
          <AutoScreenChip reviewer={review.reviewer} />
          {/* `지연 · 3일 15시간 대기` → `87h 지연` (2026-08-25 창업자 지시).
              한 조각에 같은 말이 셋이었다 — 급함·길이·그 길이가 무엇인지.
              시간 단위로 통일하면 카드끼리 크기 비교가 눈으로 된다 */}
          {urgencyLabel && (
            <span className={`${a.chip} ${urgency === "OVERDUE" ? a.chipNeg : a.chipWarn}`}>
              {formatElapsedShort(review.createdAt, now)} {urgencyLabel}
            </span>
          )}
        </span>
      </div>

      <div className={a.meta}>
        <span>
          {researcher.penName ?? researcher.email} ·{" "}
          {TIER_NAME[review.report.researcher.tier as Tier] ?? review.report.researcher.tier}
        </span>
        {/* **검수 참여자·대기 시간은 여기 다시 적지 않는다** (2026-08-26 창업자 지시).
            위 헤더 칩이 이미 말한다 — `IRIS !`(=규칙만 돌았다)와 `101h 지연`.
            같은 사실을 상세에서 또 적으면 칩을 지운 뜻이 없어진다.
            원시 표식(`rule+student:...`)은 어차피 뿌리지 않는다 — 알아야 하는 건
            "누가 봤나"뿐이고 그건 칩이 답한다 */}
        {review.report.predictionCard && (
          <span>
            시한 {new Date(review.report.predictionCard.deadline).toLocaleDateString("ko-KR")}
          </span>
        )}
        {/* 아직 아무도 못 샀는가, 이미 돈이 오갔는가 — 처분의 무게가 여기서 갈린다 */}
        <span>
          {pendingPublish
            ? "게시 보류 — 판매 전"
            : review.report.status === "PUBLISHED"
              ? `판매 중 · 에스크로 ${held.length}건 ${heldAmountKrw.toLocaleString()}원`
              : "판매 종료"}
        </span>
        {/* 소견은 규칙에서도 나오므로 "AI"로 못 박지 않는다 (건별 출처는 아래 목록에 표시) */}
        <QueueReasonChip
          decision={review.decision}
          rejectionCount={review.report.rejectionCount}
        />
      </div>

      {/* **본문 열람과 소견을 하나로 합쳤다** (2026-08-26 창업자 지시) — 예전에는 여기
          "화면 열기" 링크가, 아래에 소견 목록(FindingRow)이 따로 있었다. 이제 본문을 그
          자리에 펼치고 문제 삼은 워딩을 빨갛게 칠한다(FlaggedReport, ResolveButton 위).
          전체 화면 링크(종목·목표가·별점)는 그 컴포넌트 안으로 들어갔다 */}

      {/* 승인은 그 시점 기준으로 컷오프를 다시 검증한다 — 시한이 임박하면 승인이 실패할 수 있다 */}
      {pendingPublish && risk !== "NONE" && (
        <div className={`${a.note} ${a.noteNeg}`}>
          {risk === "PASSED"
            ? "검증 시한이 이미 지났습니다 — 승인해도 게시되지 않습니다. 반려해 주세요."
            : "검증 시한이 48시간 내입니다 — 대기가 더 길어지면 최소 시한 규칙에 걸려 승인이 실패할 수 있습니다."}
        </div>
      )}

      {/* '반드시 물어야 하는 건' 안내는 걷었다 (2026-08-27 창업자 지시) — 교사 질문지가
          결정 후 "교사 답 대기" 줄(TeacherRelayPanel)로 옮겨진 뒤로 이 큐에서 물어보라는
          안내는 자리를 잃었다. 여기서는 판정만 내린다 (ResolveButton) */}

      {/* **본문 + 빨간 소견** — 문제 삼은 워딩을 본문 맥락 안에서 곧장 읽는다.
          문장을 못 짚은 소견(IRIS 전체 판정·표기 변형)은 그 아래 따로 뜨고,
          전체 화면 링크(종목·목표가·별점)도 이 안에 있다 */}
      <FlaggedReport
        reportId={review.report.id}
        title={review.report.title}
        content={review.report.content}
        findings={fromComplianceFindings(findings)}
      />

      <ResolveButton
        reviewId={review.id}
        reportId={review.report.id}
        reportStatus={review.report.status}
        heldPurchases={held.length}
        heldAmountKrw={heldAmountKrw}
        flaggedCategories={[...new Set(findings.map((f) => f.category))]}
        suggestedPhrase={suggestPhrase(findings)}
        // **여기서만 시간을 잰다.** 이 카드는 펼쳐졌을 때만 폼을 그리므로(접힌 상태는
        // 위의 `if (!open)` 링크다) 폼의 마운트가 곧 열람이다. 판매 중 목록은 카드마다
        // 폼을 한꺼번에 그려 마운트가 열람이 아니므로 재지 않는다
        measure
      />

      {/* **사유 말고 할 말** (2026-08-20 사용자 지시) — 신고 카드의 철회 확인 창에 있는
          그 상자와 같은 물건이다.
          위의 반려 사유는 처분에 실려 나가는 **정형문의 한 칸**이라 "무엇이 걸렸다"까지만
          말할 수 있다. 그런데 검수 보류에서 운영자가 실제로 하고 싶은 말은 대개 그 다음이다 —
          어디를 어떻게 고치면 통과하는지, 이번 건은 다시 내도 되는지. 그건 사유 칸에 쓰면
          처분 기록에 섞이고, 안 쓰면 아무 데도 남지 않는다. */}
      {/* **이 상자는 덧붙이는 말이다** (2026-08-20 사용자 확정) — 승인·반려 모두
          누르는 순간 정형 통지가 자동으로 나가므로, 안 써도 리서처는 결과를 안다.
          여기 쓰는 것은 정형문이 담지 못하는 것뿐이다: 어디를 어떻게 고치면 통과하는지,
          이번 건은 다시 내도 되는지 */}
      <div className={a.lbl} style={{ marginTop: 16 }}>
        리서처에게 <small>결과는 자동으로 갑니다 — 여기는 덧붙일 말이 있을 때만</small>
      </div>
      <DirectMessage
        userId={researcher.id}
        name={researcher.penName ?? researcher.email}
        quote={`${researcher.penName ?? researcher.email} 님에게 할 말 쓰기`}
        action="알림"
        title={REVIEW_REJECTED_TITLE}
      />

      <FoldLink href={base} />
    </div>
  );
}

/**
 * 접기 — 펼친 카드를 다시 줄로 되돌린다 (2026-08-20 사용자 지시).
 *
 * **아래 가운데**에 둔다. 펼친 카드를 접는 사람은 그 카드를 **다 읽은 뒤**라 시선이
 * 이미 바닥에 있고, 가운데인 이유는 좌우 어느 쪽도 이 동작의 편이 아니기 때문이다
 * (판단 버튼은 좌우로 갈리는데 접기는 판단이 아니다).
 *
 * `scroll={false}`가 핵심이다 — 접으면서 맨 위로 튀면 방금 보던 자리를 잃는다.
 */
function FoldLink({ href }: { href: string }) {
  return (
    <Link href={href} className={a.fold} scroll={false}>
      접기 ⌃
    </Link>
  );
}

// 검수 정확도 패널 — 운영자 자신의 결정이 만들어낸 지표를 결정 화면 위에 둔다.
// 여기 오탐률이 보이면 "왜 매번 멀쩡한 리포트가 올라오지"가 감이 아니라 수치가 된다.
function pct(v: number | null) {
  return v === null ? "-" : `${Math.round(v * 100)}%`;
}

function AccuracyPanel({ summary }: { summary: AccuracySummary }) {
  if (summary.labeled === 0) {
    return (
      <p className={a.hint}>
        아직 판정 표본이 없습니다. 승인·반려·철회를 내리면 그 결정이 검수의 정답 라벨이 되어
        오탐률·미탐 건수가 여기 집계됩니다.
      </p>
    );
  }
  /* **한 줄이 전부다** (2026-08-23 창업자 지시).
     이 줄은 IRIS 상자 맨 위에 얹혀 매일 곁눈질로 잡는 자리라, 숫자 셋 말고는 아무것도
     두지 않는다. 표본·유형별 분해·물음표는 **상세 화면**(/admin/compliance/iris)이
     건수와 함께 편다 — 상자를 누르면 거기로 가므로 여는 손잡이가 여기 또 있으면
     같은 설명이 두 곳에 생기고, 그러면 하나는 반드시 낡는다. */
  return (
    <div className={a.row}>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-weak)" }}>
        검수 정확도 90일
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-weak)" }}>
        정탐 <b style={{ color: "#0e8a71" }}>{pct(summary.precision)}</b> · 오탐{" "}
        <b style={{ color: summary.falsePositive > 0 ? "#b45309" : undefined }}>
          {pct(summary.falsePositiveRate)}
        </b>{" "}
        · 미탐{" "}
        <b style={{ color: summary.falseNegative > 0 ? "#c4303b" : undefined }}>
          {summary.falseNegative}건
        </b>
      </span>
    </div>
  );
}

export default async function AdminCompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; sort?: string; open?: string; full?: string }>;
}) {
  const userId = await getSessionUserId();
  if (!userId) notFound();
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (user?.role !== "OPERATOR") notFound();

  const [
    pending,
    published,
    accuracy,
    rollback,
    autoShadowed,
    phrases,
    abuseRows,
    manualQueue,
    pause,
    canary,
    teacherPending,
    graduationWatch,
    retrain,
    regressionCases,
    rescanQueue,
  ] = await Promise.all([
    getPendingComplianceReviews(prisma),
    getPublishedReportsForOversight(prisma),
    getScreeningAccuracy(prisma),
    getStudentRollbackStatus(prisma),
    isAutoShadowed(prisma),
    getLearnedPhraseStats(prisma),
    getAbuseReports(prisma),
    getManualJudgmentQueue(prisma),
    getPauseState(prisma),
    getCanaryScreen(prisma),
    getTeacherAnswerPending(prisma),
    getGraduationWatch(prisma),
    countHardNegatives(prisma),
    getRegressionCases(prisma),
    getRescanQueue(prisma),
  ]);
  // 문항은 사전 항목에 붙어 있다 — 졸업이 만든 것이라 그 항목 카드에서 닿는 것이 맞다.
  // (관찰 큐는 7일짜리 임시 자리고 문항은 영구라 수명이 안 맞는다 — 회신 4호 §4-b)
  const casesByPhrase = new Map<string, typeof regressionCases>();
  for (const c of regressionCases) {
    const list = casesByPhrase.get(c.phraseId) ?? [];
    list.push(c);
    casesByPhrase.set(c.phraseId, list);
  }
  // 대기 중인 신고만, 리포트 단위로 묶는다 — 판단의 단위가 신고가 아니라 리포트다
  const abuseGroups = groupAbuseReports(abuseRows.filter((r) => r.status === "PENDING"));

  // 큐는 이미 오래된 순(= 대기가 긴 순)으로 온다. 정렬을 유지한 채 두 항목으로 나눈다.
  const now = new Date();
  // **`usable()` 은 부르지 않는다** — 그건 사이드카에 실제로 묻는 일이라 목록을 그리는
  // 값싼 경로에 둘 것이 아니고, 출근 상태 카드가 이미 그 답을 갖고 있다. 여기서 알고
  // 싶은 것은 "IRIS가 판정에 끼는 체제인가" 하나뿐이고 그건 설정값(env) 한 줄이다
  const mode = studentMode();
  const instrumentHolds = pending.filter((r) => isInstrumentOnlyHold(parseFindings(r.findingsJson)));
  const contentHolds = pending.filter((r) => !isInstrumentOnlyHold(parseFindings(r.findingsJson)));

  const sp = await searchParams;
  const raw = sp.tab as PaneKey | undefined;
  const pane: PaneKey =
    raw && [...TAB_KEYS, ...TOOL_KEYS].includes(raw) ? raw : "body";
  // 옛 링크(?tab=content|instrument)를 새 이름으로 받아 준다 — 알림에 박힌 주소가 있다
  const legacy: Record<string, PaneKey> = { content: "body", instrument: "inst" };
  const tab: PaneKey = legacy[sp.tab ?? ""] ?? pane;
  const sort: SortKey = SORT_KEYS.includes(sp.sort as SortKey) ? (sp.sort as SortKey) : "wait";

  // 펼친 신고 건의 재료만 읽는다 — 목록에서 전부 읽으면 리포트 20개의 본문을 매번 읽는다.
  // `?open=`이 그룹 열쇠(reportId)일 때만 부른다: 자유 입력 신고는 내릴 상품이 없어
  // 본문도 카드도 없다
  const openIsGroup = abuseGroups.some((g) => g.reportId && g.reportId === sp.open);
  const abuseDetail =
    tab === "body" && openIsGroup ? await getAbuseGroupDetail(prisma, sp.open!) : null;

  // **수동 판정 큐를 여기로 들인다** (시안 v3): "시세를 못 구했다"와 "종목이 위험하다"는
  // 둘 다 숫자를 봐야 끝나는 일이라 같은 화면에 있어야 한다. 전에는 /admin/judgments가
  // 따로 있어 리포트를 보다 판정하러 화면을 옮겨야 했다.
  //   시세 때문에 = 값을 못 구했거나(null) · 두 소스가 다른 값(CROSS_CHECK) ·
  //                 되돌린 카드(REVERTED_SOURCE)
  //   특이사항   = 값은 왔는데 믿을 근거가 없다(IMPLAUSIBLE_QUOTE)
  //
  // **되돌린 카드가 여기 있는 이유** (2026-08-19 사용자 확인): 되돌리기는 원인을
  // 반드시 고르게 하는데(`--source` / `--logic`), 수동 큐에 남는 것은 **시세 소스가
  // 원인일 때뿐**이다 — 로직 버그면 고친 코드로 자동 재판정하는 것이 맞아 플래그를
  // 세우지 않는다(judgmentRevertService). 즉 이 카드도 볼 곳은 거래소 시세다.
  // 처음엔 특이사항으로 보냈는데, 그건 "왜 큐에 왔나"가 아니라 "특이해 보인다"로
  // 가른 것이라 틀렸다.
  const byPrice = manualQueue.filter(
    (e) =>
      e.manualReason === null ||
      e.manualReason === "CROSS_CHECK" ||
      e.manualReason === "REVERTED_SOURCE",
  );
  const byOddity = manualQueue.filter((e) => e.manualReason === "IMPLAUSIBLE_QUOTE");
  const pausedClasses = ASSET_CLASSES.filter(
    (c) => pause.global || (pause.byAssetClass[c] ?? false),
  );
  // 보상 대기 — **아직 안내하지 않은 것만.** 안내 완료를 적을 자리가 생기기 전에는
  // 이 목록에서 나갈 방법이 없어 큐가 영영 줄지 않았다 (AbuseReport.rewardNoticedAt)
  const rewardPending = abuseRows.filter(
    (r) => r.status === "CONFIRMED" && r.rewarded && !r.rewardNoticedAt,
  );
  /** 선착순 쿼터는 **지금까지 보상 대상이 된 전부**로 센다 — 안내 여부와 무관하다 */
  const rewardedTotal = abuseRows.filter((r) => r.rewarded).length;
  const rewardGroups = groupRewardPending(rewardPending, now);

  const counts: Record<TabKey, number> = {
    // 신고 묶음도 함께 센다 — 탭 숫자가 "이 탭에서 내려야 할 결정 수"를 말해야
    // 대시보드에서 눌러볼지 말지가 판단된다
    body: contentHolds.length + abuseGroups.length,
    inst: byPrice.length + instrumentHolds.length + byOddity.length,
  };

  // 판매량 정렬용 — 보류 건은 아직 안 팔렸으므로 리서처의 누적 판매 건수를 본다
  const sales =
    sort === "sales"
      ? await researcherSalesCounts(prisma, [
          ...new Set(pending.map((r) => r.report.researcher.id)),
        ])
      : new Map<string, number>();

  const q = await getAdminQueues(prisma, now);

  /**
   * **원문은 자기 화면에서 연다** (시안 scr-rp-full).
   *
   * 판단 화면 안에 이용자 화면을 통째로 깔았더니 카드 하나가 화면 몇 개 길이가 됐다 —
   * 줄과 상세를 나눈 이유(목록은 훑고 상세는 읽는다)가 그대로 무너진다.
   * 여기서는 탭도 큐도 그리지 않는다: 이 화면에 온 목적은 **읽는 것** 하나뿐이다.
   */
  if (abuseDetail && sp.full === abuseDetail.reportId) {
    const flagged = flaggedQuotes(abuseDetail);
    return (
      <>
        <AdminHead
          title={abuseDetail.title}
          // 시안의 날짜 표기는 `8/17` — ko-KR 기본(`8. 17.`)은 점과 공백이 부제를 늘린다
          sub={`${abuseDetail.researcherName} · ${abuseDetail.tierLabel}${
            abuseDetail.publishedAt
              ? ` · ${new Date(abuseDetail.publishedAt).getMonth() + 1}/${new Date(
                  abuseDetail.publishedAt,
                ).getDate()} 게시`
              : ""
          } · 판매 ${abuseDetail.salesCount}건`}
          backHref={`/admin/compliance?tab=body&open=${abuseDetail.reportId}`}
          inbox={q.inbox}
        />
        <main className={a.page}>
          {flagged.length > 0 ? (
            <div className={`${a.note} ${a.noteNeg}`}>
              신고된 문구는 <b>붉게 칠해</b> 두었습니다. 앞뒤를 함께 읽으세요 — 같은 문장도
              맥락이 다르면 다른 글입니다.
            </div>
          ) : (
            <div className={a.note}>
              규칙·운영자 사전으로는 걸리는 문구가 없습니다 — 칠해 둔 자리가 없으니 직접
              읽어야 합니다.
            </div>
          )}
          {/* 카드로 한 번 더 감싸지 않는다 — 안에 들어오는 것이 **이미 완성된 앱 화면**이라
              콘솔의 카드를 덧씌우면 액자가 두 겹이 되고, 그 순간 "그대로 옮겨 왔다"는
              인상이 깨진다 (시안) */}
          <BuyerView detail={abuseDetail} />
          {/* 아래쪽 '판단하러 돌아가기' 줄은 두지 않는다 — 위 뒤로가기 화살표와 **같은
              곳으로 가는 두 번째 문**이다. 문이 둘이면 어느 쪽이 맞는지 한 번 판단해야
              하고, 그 판단은 아무것도 벌지 못한다 */}
        </main>
      </>
    );
  }

  return (
    <>
      <AdminHead title="리포트" inbox={q.inbox} />
      <main className={a.page}>
      {/* **맥박이 성적보다 먼저다** — 정확도는 지난 90일의 결과지만 이 줄은 지금
          이 순간 기계가 도는지를 말한다. 규칙이 죽어 있으면 정확도 숫자는
          어제까지의 이야기일 뿐이다 */}
      {/* **장애가 규칙 상태보다 먼저다** — 규칙이 전부 초록이어도 IRIS가 죽어 있으면
          지금 게시가 멈춰 있다. 그 사실이 아래 어느 숫자보다 급하다 */}
      {/* **박동 값(다음 점검·문턱 초과·스케줄러 상태)은 넘기지 않는다** (2026-08-23).
          여기서 넘기면 서버 렌더 시점의 스냅샷이라, 화면을 켜 둔 채 주기가 지나면 늙은
          값으로 **정상인데 타이머가 노랑·빨강으로 올라간다.** 패널이 라우트에서 30초마다
          직접 읽는다. 여기서 넘기는 것은 **화면이 방금 직접 잰 값**(층별 결과)과 그것을
          잰 시각뿐이고, 그건 늙으면 점이 회색으로 내려가 스스로 말한다 */}
      <StudentValvePanel
        canaryFailures={canary.failures.map((f) => ({ layer: f.layer }))}
        measuredAt={now.getTime()}
        canaryIntervalMs={CANARY_INTERVAL_MS}
        canaryStaleMs={CANARY_STALE_MS}
        /* **정확도를 같은 상자 안, 맨 위에** (2026-08-23 창업자 지시).
           검수하는 것이 둘이고 그 둘이 얼마나 맞히는지는 같은 물음의 뒷면이라 한 상자에
           둔다. 서버 컴포넌트를 **prop 으로 넘긴다** — 집계는 서버에서 끝나고, 클라이언트
           패널은 그 결과를 자리에만 놓는다(정확도 계산이 브라우저로 내려가지 않는다) */
        accuracy={<AccuracyPanel summary={accuracy} />} />
      {/* 검수 규칙 띠지(CanaryPanel)는 2026-08-23에 걷었다 — 같은 사실을 위 IRIS 상자의
          `검수 규칙` 줄이 말한다. 층별 통과 여부를 여섯 칸으로 늘어놓던 자리인데, 전부
          통과일 때는 초록 여섯 개가 아무 말도 하지 않고 화면만 먹었다. 실패했을 때
          어느 층인지는 그 줄이 배지로 이어 붙인다 */}
      <TeacherRelayPanel pending={teacherPending} />
      {/* 정확도 카드는 2026-08-23에 IRIS 상자 안(맨 위)으로 올라갔다 — 검수하는 것이
          둘이고 그 둘이 얼마나 맞히는지는 같은 물음의 뒷면이라 한자리에 둔다 */}

      {/* **판단 소요 시간은 검수 상세로 내려갔다** (2026-08-24 창업자 지시).
          계기판은 매일 곁눈질하는 화면이고 이 표는 유형별 중앙값이라 **되짚으러 왔을 때**
          읽는 값이다. 정확도 옆에 두려던 원래 뜻("무엇을 틀렸나" 옆에 "읽고 틀렸나")은
          그대로인데, 정확도 상세가 이미 거기 있으므로 옆자리도 같이 옮겼다.
          → src/app/admin/compliance/iris/page.tsx */}

      {/* **문턱에 닿았을 때만 여기 뜬다** (2026-08-23 창업자 지시).
          평소 이 숫자는 0/50 에서 며칠씩 움직이지 않는다 — 매일 보는 화면에서
          안 변하는 숫자는 읽히지 않고 자리만 차지하다가, 정작 47이 됐을 때도 그냥
          지나치게 된다. 그래서 **닿기 전에는 검수 상세로 접어 두고**, 닿는 순간
          여기로 올라온다: 그때는 "창업자가 진위를 가릴 차례"라는 할 일이 생기고,
          할 일은 계기판에 있어야 한다 */}
      {retrain.reached && <RetrainGauge {...retrain} />}

      {/* IRIS을 계속 켜 둘 것인가 (9차 G-4).
          채택선과 **같은 공식**(순이익)으로 최근 창을 다시 잰다 — 켤 때와 끌 때의
          잣대가 다르면 두 판단이 서로를 반박한다.
          표본이 없을 때는 그리지 않는다: 0건짜리 계기판은 정보가 아니라 장식이고,
          매일 보이면 곧 안 보이게 된다. */}
      {(rollback.scored > 0 || autoShadowed) && (
        <section
          style={{
            margin: "0 16px 12px",
            padding: "10px 12px",
            borderRadius: 10,
            border: `1px solid ${autoShadowed || rollback.shouldRollback ? "var(--neg)" : "var(--line)"}`,
            background:
              autoShadowed || rollback.shouldRollback ? "var(--neg-weak, #fff5f5)" : "transparent",
            fontSize: 13,
            color: "var(--text-weak)",
          }}
        >
          <strong style={{ color: "var(--text)" }}>IRIS 순이익</strong>{" "}
          <span style={{ color: "var(--text-faint)" }}>· 운영자 판정 기준</span>
          <br />
          {rollback.summary}
          {/* 격하됐으면 **그 사실이 먼저다.** 위 순이익은 격하 이후로 갱신되지 않는다 —
              IRIS가 소견을 안 내므로 잴 재료 자체가 없다. 그 사실을 말하지 않으면
              운영자가 "숫자가 안 나빠졌으니 괜찮다"로 읽는다 (10차 I-6). */}
          {autoShadowed ? (
            <>
              <br />
              <strong style={{ color: "var(--neg)" }}>
                자동 격하됨 — 지금 규칙 단독으로 검수 중입니다.
              </strong>
              <br />
              위 수치는 격하 시점에 멈춰 있습니다(끈 동안에는 IRIS의 성적을 잴 수 없습니다).
              재학습하고 <code>npm run eval:student</code> 로 채택선을 다시 통과시킨 뒤
              해제하십시오.
              <StudentShadowRelease />
            </>
          ) : (
            rollback.shouldRollback && (
              <>
                <br />
                <strong style={{ color: "var(--neg)" }}>
                  적자입니다 — 다음 검수 때 자동으로 격하됩니다.
                </strong>
              </>
            )
          )}
        </section>
      )}

      {/* 보류 사유별로 화면을 분리한다 — 판단 기준이 다른 건을 한 화면에서 섞어 보지 않게.
          붉은 점(tdot)은 **지금 안 하면 심대한 것이 그 탭에 있다**는 뜻이다 —
          숫자만으로는 6건이 급한 6건인지 느긋한 6건인지 구별되지 않는다 */}
      <div className={a.subtabs}>
        {TAB_KEYS.map((key) => (
          <Link
            key={key}
            href={`/admin/compliance?tab=${key}&sort=${sort}`}
            className={`${a.subtab} ${key === tab ? a.subtabOn : ""}`}
          >
            {TABS[key].label}
            {counts[key] > 0 && ` ${counts[key]}`}
            {key === "body" && abuseGroups.some((g) => g.suspended) && <span className={a.tdot} />}
            {key === "inst" && pausedClasses.length > 0 && <span className={a.tdot} />}
          </Link>
        ))}
      </div>

      {/* 탭 설명 문단은 두지 않는다 (시안) — 탭 이름이 이미 재료를 말하고, 그 아래
          묶음마다 물음표가 있다. 여기 한 문단을 더 두면 화면을 열 때마다 읽을 것이
          하나 늘고, 매일 지나치는 문단이 하나 더 생긴다 */}

      {/* 정렬은 **본문 탭에만** 있다 (시안) — 종목·시세는 상한까지 남은 날이 순서를
          정하므로 사람이 고를 축이 없다 */}
      {tab === "body" && <SortBar tab={tab} sort={sort} />}

      {tab === "body" && (
        <>
          {/* **본문 탭은 두 묶음이다 — 시점이 정반대라 섞으면 안 된다** (2026-08-19).
              위는 게시 **전**에 기계가 막은 것(아직 아무도 못 샀다), 아래는 게시 **후**에
              사람이 잡은 것(검수가 놓쳤고 지금 팔리는 중이다).
              재료는 둘 다 본문이라 같은 화면이 맞지만, 급함이 다르니 자리를 가른다 */}
          <SecHead title={<>이용자가 잡은 것 <span className={a.n}>{abuseGroups.length}</span></>}>게시된 <b>뒤</b>에 신고로 들어왔습니다 — 검수가 <b>놓친 것(미탐)</b>이고 이미
              팔린 뒤입니다. 확인하면 강제 철회로 닫히고, <b>그 판단이 그대로 검수 모델의
              학습 자료</b>가 됩니다.
              <br />
              <br />
              <b>서로 다른 신고자가 3명이 되면 판매가 저절로 멈춥니다.</b> 한 사람의 말로는
              아무것도 멈추지 않습니다 — 신고는 공짜인데 잃은 판매 기간은 되돌릴 장치가
              없기 때문입니다. 기계가 건 중단이라 <b>사람이 풀어야 끝납니다.</b></SecHead>
          <AbuseUserCaught groups={abuseGroups} openId={sp.open} detail={abuseDetail} now={now} />

          <SecHead title={<>검수 모델이 세운 것{" "}
              <span className={`${a.n} ${contentHolds.length === 0 ? a.nCalm : ""}`}>
                {contentHolds.length}
              </span></>}>게시되기 <b>전</b>에 규칙·AI가 막았습니다. 아직 아무도 못 샀습니다 — 판매
              시작이 운영자 결정에 달려 있습니다.</SecHead>
          {/* **IRIS가 판정에 안 끼는 동안은 목록 머리에서 한 번만 말한다** (3회차 C-4 →
              회신 3호). 카드마다 붙이면 상시 문구가 반복돼 노이즈가 되고, IRIS가 라이브로
              돌아오는 날 전 카드의 문구를 떼야 하는 동기화 부담이 생긴다.
              카드 단위 표시는 라이브일 때의 `[IRIS · 확신 N%]` 배지 하나로 충분하다.
              — 이 줄이 없으면 큐 카드만 보는 운영자는 "IRIS가 아무것도 안 잡네"로 읽는다 */}
          {mode !== "live" && contentHolds.length > 0 && (
            <div className={a.note}>
              <b>IRIS: {mode === "shadow" ? "연수 중(기록만)" : "꺼짐"}</b> — 이 큐의
              소견은 규칙 단독입니다.
            </div>
          )}
          {sort === "wait" && <UrgencyLine {...urgencySummary(contentHolds, now)} />}

          {/* **판매 중 — 새 기준에 걸린 게시물** (2026-08-25 창업자 확정).
              맨 위인 이유: 이 묶음만 **돈이 걸려 있다.** 아래 셋은 아직 아무도 못 샀지만
              여기는 이미 팔렸고, 내리면 전액 환불 + 정산 0 + 점수 0 이다.
              0건이면 아무것도 그리지 않는다 — 평소 0인 자리가 매일 보이면 배경음이 된다 */}
          {rescanQueue.length > 0 && (
            <>
              <SubHead
                title="판매 중"
                count={rescanQueue.length}
                note="새로 등록한 학습 표현이 이미 게시된 리포트를 잡았습니다. 게시는 그대로입니다 — 내릴지는 확인하고 정하십시오."
              />
              {rescanQueue.map((h) => (
                <RescanRow key={h.id} hit={h} now={now} />
              ))}
            </>
          )}

          {contentHolds.length === 0 && rescanQueue.length === 0 ? (
            <p className={a.empty}>본문 검수로 보류된 건이 없습니다.</p>
          ) : (
            /* **셋으로 나눈다** (2026-08-25 창업자 확정) — 운영자가 하는 일이 다르다.
               순서가 곧 무게다: 검수를 못 믿는 것 → 성격이 다른 것 → 평상시 업무.
               묶음이 비면 그리지 않는다 — 빈 제목은 정보가 아니라 장식이다 */
            (
              [
                ["fail", "검수 실패"],
                ["rejected", "반려 3회"],
                ["ok", "검수 성공"],
              ] as const
            ).map(([key, label]) => {
              const group = sortPending(contentHolds, sort, sales).filter(
                (r) => holdGroup(r) === key,
              );
              if (group.length === 0) return null;
              return (
                <div key={key}>
                  <SubHead title={label} count={group.length} note={HOLD_GROUP_NOTE[key]} />
                  {group.map((review) => (
                    <ReviewCard
                      key={review.id}
                      review={review}
                      now={now}
                      open={sp.open === review.id}
                      tab={tab}
                      sort={sort}
                    />
                  ))}
                </div>
              );
            })
          )}

          {/* 신고 확인의 후속 — 판단이 아니라 **약속을 지키는 일**이라 큐를 따로 둔다 */}
          <SecHead title={<>신고 보상 지급 대기{" "}
              <span className={`${a.n} ${rewardPending.length === 0 ? a.nCalm : ""}`}>
                {rewardPending.length}
              </span></>}>확인된 신고에 <b>보상을 약속했습니다.</b> 지금은 쿠폰 시스템이 없어 개별로
              안내합니다 — 연 몇 건이라 손으로 충분하고, 목록이 남아 있어 나중에{" "}
              <b>소급 발행</b>도 됩니다.
              <br />
              <br />
              약속한 문구: <b>&ldquo;확인되었습니다 — 보상은 개별로 안내드립니다.&rdquo;</b>{" "}
              쿠폰이 아직 없으니 <b>지급될 예정</b>이라고 말하지 않습니다. 지키지 못할 말을
              먼저 하지 않는 것이 이 목록의 이유입니다.</SecHead>
          {/* **묶음으로 안내한다** (시안 rp-4) — 한 리포트가 확인되면 그 신고자
              전원에게 같은 말을 보낸다. 사람마다 줄을 두면 같은 문장을 세 번 쓰게 되고,
              세 번 쓰는 일은 언젠가 두 번만 쓰게 된다 */}
          {rewardGroups.length === 0 ? (
            <div className={a.empty}>
              <span className={a.dot} />
              안내를 기다리는 신고 보상이 없습니다
            </div>
          ) : (
            rewardGroups.map((g) => (
              <div key={g.reportId} className={a.card}>
                <div className={a.row}>
                  <span className={a.ttl}>신고자 {g.reporters.length}명 · 안내 대기</span>
                  <span className={`${a.chip} ${a.chipWarn}`}>최장 {g.waitedDays}일</span>
                </div>
                <div className={a.meta}>
                  <span>{g.title}</span>
                  <span>
                    선착순 남은 수량 {REWARD_QUOTA - rewardedTotal} / {REWARD_QUOTA}
                  </span>
                  <span>확인된 신고에만 지급</span>
                </div>
                <RewardNotice reportId={g.reportId} reporters={g.reporters} />
              </div>
            ))
          )}

          {/* 도구는 큐가 아니다 — 매일 세어야 할 것과 가끔 여는 것을 같은 줄에 두지 않는다 */}
          <SecHead title={<>도구 <span className={`${a.n} ${a.nCalm}`}>—</span></>}>큐가 아니라 사전입니다. 반려하면서 남긴 표현이 다음 리서처의{" "}
              <b>작성 화면</b>에서 미리 경고를 냅니다.</SecHead>
          <Link href="/admin/compliance?tab=phrases" className={a.xref}>
            <span>
              운영자 사전 {phrases.filter((p) => p.active).length}개
              {phrases.some((p) => p.needsReview) && (
                <small style={{ color: "#b45309" }}>
                  {" "}
                  · 재검토 권장 {phrases.filter((p) => p.needsReview).length}
                </small>
              )}
            </span>
            <span className={a.go}>›</span>
          </Link>
          <Link href="/admin/compliance?tab=published" className={a.xref}>
            <span>
              판매 중 리포트 {published.length}건{" "}
              <small>— 신고 없이 직접 내려야 할 때</small>
            </span>
            <span className={a.go}>›</span>
          </Link>
        </>
      )}

      {tab === "inst" && (
        <>
          {/* 판정이 멈춰 있으면 이 화면의 모든 숫자가 그 사실 위에 있다 —
              맨 위에서 먼저 말하지 않으면 아래 큐가 왜 안 줄어드는지 알 수 없다 */}
          {pausedClasses.length > 0 && (
            <div className={`${a.card} ${a.stripeNeg}`}>
              <div className={a.row}>
                <span className={a.ttl} style={{ color: "#c4303b" }}>
                  {pausedClasses.map((c) => ASSET_CLASS_LABEL[c]).join(" · ")} 자동 판정 정지
                </span>
                <span className={`${a.chip} ${a.chipNeg}`}>P0</span>
              </div>
              <div className={`${a.note} ${a.noteNeg}`}>
                정지 중에도 <b>14일 상한(전액 환불)은 계속 집행됩니다.</b> 소스를 대조하기
                전에는 풀지 마세요.
              </div>
              <Link href="/admin/settings" className={a.xref} style={{ marginTop: 10 }}>
                <span>
                  운영 설정에서 재개 <small>— 사유를 적어야 열립니다</small>
                </span>
                <span className={a.go}>›</span>
              </Link>
            </div>
          )}

          <SecHead title={<>시세 때문에{" "}
              <span className={`${a.n} ${byPrice.length === 0 ? a.nCalm : ""}`}>
                {byPrice.length}
              </span></>}>종목은 멀쩡한데 <b>값</b>이 문제입니다 — 값을 못 구했거나, 두 소스가 서로 다른
              값을 냅니다. 볼 것은 거래소 시세입니다.</SecHead>
          <ManualQueueList entries={byPrice} empty="시세 때문에 밀린 카드가 없습니다" openId={sp.open} tab={tab} />

          <SecHead title={<>종목 때문에{" "}
              <span className={`${a.n} ${instrumentHolds.length === 0 ? a.nCalm : ""}`}>
                {instrumentHolds.length}
              </span></>}>값이 아니라 <b>종목 자체</b>가 문제입니다 — 거래소가 지정했거나, 거래가
              멈췄거나, 기준 미만 시가총액입니다. 볼 것은 거래소 공지입니다. 위법이 아니라
              위험이므로 사람이 판단합니다.</SecHead>
          {sort === "wait" && <UrgencyLine {...urgencySummary(instrumentHolds, now)} />}
          {instrumentHolds.length === 0 ? (
            <div className={a.empty}>
              <span className={a.dot} />
              위험 종목으로 보류된 건이 없습니다
            </div>
          ) : (
            sortPending(instrumentHolds, sort, sales).map((review) => (
              <ReviewCard
                key={review.id}
                review={review}
                now={now}
                open={sp.open === review.id}
                tab={tab}
                sort={sort}
              />
            ))
          )}

          <SecHead title={<>특이사항{" "}
              <span className={`${a.n} ${byOddity.length === 0 ? a.nCalm : ""}`}>
                {byOddity.length}
              </span></>}>값은 왔는데 <b>믿을 근거가 없어</b> 규칙이 세운 것들입니다 — 하루 등락이
              가격제한폭을 넘거나, 거래량은 평소인데 값만 튄 일봉. 자동으로 통과시키면
              그 한 줄로 돈이 갈립니다.</SecHead>
          <ManualQueueList entries={byOddity} empty="규칙이 세운 카드가 없습니다" openId={sp.open} tab={tab} />
        </>
      )}

      {/* 도구 두 화면은 시안의 5화면에 없다 — 가끔 여는 곳이라 무엇을 하는 곳인지가
          매번 필요하다. 그래도 같은 문법으로 접어 둔다 */}
      {(tab === "phrases" || tab === "published") && (
        <SecHead title={TOOLS[tab as ToolKey].label}>{TOOLS[tab as ToolKey].description}</SecHead>
      )}

      {/* **졸업 직후 7일이 가장 위험하다** — 사전 보호가 꺼지고 IRIS만 남는 창이다.
          목록 위에 얹는 이유: 졸업시킨 사람이 결과를 보러 갈 곳을 따로 기억하지 않게 */}
      {tab === "phrases" && graduationWatch.length > 0 && (
        <>
          <SecHead title={<>졸업 관찰{" "}
              <span className={`${a.n} ${graduationWatch.some((r) => r.studentMissCount > 0) ? "" : a.nCalm}`}>
                {graduationWatch.length}
              </span></>}>사전에서 <b>내린 지 {GRADUATION_WATCH_DAYS}일 안</b>인 표현입니다. 지금은 IRIS만 이
              표현을 맡고 있어, IRIS가 놓치면 <b>아무도 막지 않습니다.</b> 놓친 것이 쌓이면
              졸업이 성급했다는 증거이므로 되살리십시오.</SecHead>
          {/* `getGraduationWatch` 는 `graduatedAt: { gte: cutoff }` 로 이미 걸렀지만
              프리즈마 타입은 여전히 nullable 이다. 있을 수 없는 행을 위한 빈 화면을
              그리느니 여기서 좁힌다 — 걸러진 행이 생기면 안 보일 뿐 터지지 않는다 */}
          <GraduationWatch
            rows={graduationWatch.filter(
              (r): r is (typeof graduationWatch)[number] & { graduatedAt: Date } =>
                r.graduatedAt !== null,
            )}
            now={now}
          />
        </>
      )}

      {tab === "phrases" &&
        (phrases.length === 0 ? (
          <p className={a.empty}>
            아직 등록된 표현이 없습니다. 반려·강제 철회 시 &ldquo;작성 화면에 등록할 표현&rdquo;에
            한 줄 적으면 다음 리서처는 작성 중에 같은 실수를 피할 수 있습니다.
          </p>
        ) : (
          phrases.map((p) => (
            <div
              key={p.id}
              // 소견의 `[규칙 · 사전]` 칩이 이 자리로 곧장 온다 (FindingRow).
              // 목록 맨 위로만 보내면 사전이 길어질수록 "어느 항목이었지"를 다시 찾아야 하고,
              // 그 마찰이 곧 **끄지 않는 이유**가 된다 — 링크의 값어치가 정확히 여기 있다
              id={`p-${p.id}`}
              className={a.card}
              style={{
                // 앵커로 뛰어들 때 헤더 밑에 숨지 않게 — 상단 여백을 미리 확보한다
                scrollMarginTop: 72,
                ...(p.needsReview
                  ? {
                      borderLeft: "4px solid var(--warn)",
                      background: "color-mix(in srgb, var(--warn) 5%, var(--bg))",
                    }
                  : {}),
              }}
            >
              <div className={a.row}>
                <div className={a.ttl}>&ldquo;{p.phrase}&rdquo;</div>
                <div style={{ display: "flex", gap: 6 }}>
                  {p.needsReview && (
                    <span className={`${a.chip} ${a.chipWarn}`}>재검토 권장</span>
                  )}
                  {/* **꺼진 이유가 둘인데 얼굴이 하나였다** (회신 5호 Q3 계약):
                        졸업   = active false + graduatedAt 있음 — IRIS에게 넘겼다
                        비활성 = active false + graduatedAt 없음 — 오탐이라 꺼 뒀다
                      둘 다 "비활성"으로 그리면 "다시 활성화"가 무슨 뜻인지 갈린다 —
                      한쪽은 되살리기고 다른 쪽은 졸업 취소다.
                      재활성화하면 graduatedAt 은 남지만 active 가 true 로 돌아오므로
                      이 칩도 '활성'으로 돌아간다 (그래서 active 를 먼저 본다) */}
                  <span
                    className={`${a.chip} ${p.active ? a.chipMint : p.graduatedAt ? a.chipWarn : ""}`}
                  >
                    {p.active ? "활성" : p.graduatedAt ? "졸업 — IRIS가 맡음" : "비활성"}
                  </span>
                </div>
              </div>
              <div className={a.meta}>
                <span>{RISK_CATEGORY_LABEL[p.category]}</span>
                <span>
                  걸림 {p.matchCount}회 · 반려 확정 {p.confirmedCount}회
                  {p.precision !== null && ` (정확도 ${Math.round(p.precision * 100)}%)`}
                </span>
                <span>{new Date(p.createdAt).toLocaleDateString("ko-KR")} 등록</span>
              </div>
              {/* **자격이 있어도 적는다** (3회차 C-2 → 회신 3호 (가)). 자격 없을 때만
                  적으면 나머지 항목은 "전부 감시"로 읽히는데, 연락처 숫자 묶음과 표기 훼손
                  신호는 **개별 표현이 아니라 글 전체의 성질**을 보는 자리라 사전이 관여할
                  곳이 원리적으로 없다. 운영자가 그것을 알 이유가 없으므로 화면이 말한다.
                  층 번호(L1~L6)는 쓰지 않는다 — 운영자 어휘가 아니다 */}
              {/* **꺼진 항목은 아무것도 감시하지 않는다.** 어제 이 줄을 넣을 때 활성 여부를
                  안 봐서, 졸업했거나 꺼 둔 항목에도 현재형으로 "감시:" 가 붙어 있었다 —
                  카드가 바로 위에서 `졸업 — IRIS가 맡음` 이라고 말해 놓고 다음 줄에서
                  자기가 감시한다고 말하는 꼴이었다.
                  꺼진 항목에도 층 정보는 남긴다(되찾을지 판단하는 재료다) — 다만 시제를
                  바꿔 **조건문**으로 적는다 */}
              <div className={a.meta}>
                <span>
                  {p.active ? "감시: " : "되찾으면 감시: "}
                  원문 · 기호 제거 · 깊은 정규화
                  {p.phoneticEligible ? " · 음성 변형" : ""}
                </span>
                {!p.phoneticEligible && <span>근사 표기 제외 — 등록 시 충돌</span>}
                {p.capExempt && <span>밀어내기 면제</span>}
              </div>
              {p.active && <PromotionCandidate p={p} now={now} />}
              {p.note && <p className={a.hint}>{p.note}</p>}
              {p.needsReview && (
                <p className={a.hint} style={{ color: "var(--warn)", fontWeight: 600 }}>
                  여러 번 걸렸지만 대부분 승인으로 끝났습니다 — 정상 표현까지 잡고 있을
                  가능성이 큽니다.
                </p>
              )}
              <PhraseToggle phraseId={p.id} active={p.active} graduated={!!p.graduatedAt} />
              {/* **졸업한 항목에만** 문항이 붙는다 — 문항은 졸업이 만든 것이고, 되찾아
                  온 항목에도 그대로 남아 있어야 한다(이중 방어라 계속 IRIS를 시험한다).
                  그래서 조건은 graduatedAt 이지 active 가 아니다 */}
              {p.graduatedAt && (
                <RegressionCases
                  cases={(casesByPhrase.get(p.id) ?? []).map((c) => ({
                    id: c.id,
                    text: c.text,
                    expectViolation: c.expectViolation,
                    category: c.category,
                    gateFailCount: c.gateFailCount,
                    lastGateFailAt: c.lastGateFailAt?.toISOString() ?? null,
                    lastGateFailSha: c.lastGateFailSha,
                  }))}
                />
              )}
              {/* **졸업은 켜져 있는 항목에만** — 꺼진 항목은 이미 아무것도 안 잡고 있어
                  넘길 것이 없다(서비스도 '이미 꺼진 항목입니다'로 거절한다).
                  상수는 서버에서 읽어 내려보낸다: 실측 재조정되는 값이라 화면에 숫자로
                  박으면 그날 화면과 서버가 갈라진다 */}
              {p.active && (
                <GraduateButton
                  phraseId={p.id}
                  phrase={p.phrase}
                  category={p.category}
                  studentMode={mode}
                  minPerSide={GRADUATION_MIN_CASES_PER_SIDE}
                  maxPairSimilarity={GRADUATION_MAX_PAIR_SIMILARITY}
                />
              )}
            </div>
          ))
        ))}

      {tab === "published" &&
        (published.length === 0 ? (
        <p className={a.empty}>판매 중인 리포트가 없습니다.</p>
      ) : (
        sortPublished(published, sort).map((report) => {
          const heldAmountKrw = report.purchases.reduce((sum, p) => sum + p.amountKrw, 0);
          const author = report.researcher.user;
          return (
            <div key={report.id} className={a.card}>
              <div className={a.row}>
                <div className={a.ttl}>{report.title}</div>
                <span className={`${a.chip} ${a.chipMint}`}>판매 중</span>
              </div>
              <div className={a.meta}>
                <span>
                  {author.penName ?? author.email} · {report.researcher.tier}
                </span>
                <span>
                  {report.publishedAt
                    ? new Date(report.publishedAt).toLocaleDateString("ko-KR")
                    : "-"}
                </span>
                <span>
                  {report.predictionCard
                    ? `시한 ${new Date(report.predictionCard.deadline).toLocaleDateString("ko-KR")}`
                    : "시한 -"}
                </span>
                <span>
                  판매 {report._count.purchases}건 · 에스크로 {report.purchases.length}건{" "}
                  {heldAmountKrw.toLocaleString()}원
                </span>
                <Link href={`/report/${report.id}`}>이용자가 보는 화면 그대로 열기 →</Link>
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
    </>
  );
}
