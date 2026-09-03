import { RISK_CATEGORY_LABEL, type Finding, type RiskCategory } from "@/domain/compliance";

// ── 범용 소견 형태 (2026-08-27 창업자 지시: 검수·신고 카드 통일) ─────────────
// 검수(RISK 유형)와 신고(신고자가 고른 유형)가 **같은 카드**(FlaggedReport)를 쓰도록,
// 카드가 아는 것은 이 최소 형태뿐이다. 각 경로가 자기 데이터를 여기로 변환해 넘긴다.
//
// ⚠ 이 파일은 **client 지시("use client")가 없다** — FlaggedReport 는 client 컴포넌트라
// 거기서 어댑터를 export 하면 server 컴포넌트(검수 page.tsx)가 부를 수 없다. 변환은
// server 에서도 돌아야 하므로 순수 모듈로 떼어 둔다.

export interface FlaggedFinding {
  quote: string;
  /** 유형 키 — 칩 필터의 식별자 */
  category: string;
  /** 칩·툴팁에 보일 유형 이름 */
  label: string;
  severity: "BLOCK" | "WARN";
  /** 툴팁 보조 — 검수는 출처(규칙·코드/ARGOS), 신고는 신고자 표시 */
  sublabel?: string;
  /** 툴팁 근거 */
  note?: string;
}

/** 검수 소견(Finding) → 범용 카드 소견. RISK 라벨·출처를 여기서 붙인다 */
export function fromComplianceFindings(findings: Finding[]): FlaggedFinding[] {
  return findings.map((f) => ({
    quote: f.quote ?? "",
    category: f.category,
    label: RISK_CATEGORY_LABEL[f.category as RiskCategory] ?? f.category,
    severity: f.severity === "BLOCK" ? "BLOCK" : "WARN",
    sublabel: complianceSource(f),
    note: f.reason ?? undefined,
  }));
}

function complianceSource(f: Finding): string {
  if (f.source === "student") return "ARGOS";
  if (f.source === "learned") return "규칙·사전";
  if (f.source === "rule") return "규칙·코드";
  return f.source ?? "출처 미기록";
}
