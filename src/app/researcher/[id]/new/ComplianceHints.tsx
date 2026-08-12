"use client";

import { useEffect, useRef, useState } from "react";
import { RISK_CATEGORY_LABEL, type Finding, type RiskCategory } from "@/domain/compliance";
import type { AssetClass } from "@/domain/constants";
import type { RiskLevel } from "@/domain/instrumentRisk";
import styles from "../../researcher.module.css";

// 작성 중 사전 검사 (2-A).
//
// 지금까지 리서처는 다 쓰고 제출한 뒤에야 "이 표현 때문에 보류됐습니다"를 들었다.
// 그 사이에 AI 검수 비용 한 번, 운영자 판단 한 번, 리서처 대기 몇 시간이 발생한다.
// 원인이 단어 하나면 그 전부가 낭비다. 1차 검수(결정적 규칙 + 학습 표현)는 AI 호출이
// 없으므로 작성 중에 미리 돌려도 비용이 사실상 0이다.
//
// 두 가지를 지킨다:
//  ① 검사는 서버에서 돈다 — 규칙과 학습 표현 사전을 브라우저 번들에 노출하지 않기 위함
//  ② "통과 보장"이라고 말하지 않는다 — 2차 AI 검수는 제출 시점에만 돌기 때문.
//     소견이 없을 때 할 수 있는 말은 "명백한 금지 표현은 없다"까지다

interface CheckInput {
  title: string;
  summary: string;
  content: string;
  assetClass: AssetClass;
  assetName: string;
  direction: string;
  riskLevel?: RiskLevel;
  riskNote?: string | null;
  delistingRisk?: boolean;
  marketCap?: number | null;
  targetType?: string;
  magnitudePct?: number | null;
  horizonDays?: number | null;
  confidence?: number | null;
  /** 크기 상한 규칙이 종목 변동성을 함께 본다 */
  sigmaDaily?: number | null;
}

type CategoryRates = Partial<Record<RiskCategory, { flagged: number; approved: number }>>;

/** 이 글자 수 아래에서는 검사하지 않는다 — 쓰는 중인 문장을 지적하면 성가시다 */
const MIN_LENGTH = 30;
const DEBOUNCE_MS = 600;

/** 결과에 입력 키를 함께 담는다 — 입력이 바뀐 뒤 옛 결과가 남아 보이지 않게 */
interface CheckResult {
  key: string;
  findings: Finding[];
  rates: CategoryRates;
}

export function ComplianceHints({ input }: { input: CheckInput }) {
  const [result, setResult] = useState<CheckResult | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const text = `${input.title}${input.summary}${input.content}`;
  const enough = text.trim().length >= MIN_LENGTH;
  // 검사에 영향을 주는 값만 의존성으로 삼는다 (객체 참조가 매 렌더 바뀌므로)
  const key = JSON.stringify(input);

  useEffect(() => {
    if (!enough) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/compliance/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: key,
        });
        if (!res.ok) return;
        const data = await res.json();
        setResult({ key, findings: data.findings ?? [], rates: data.categoryRates ?? {} });
      } catch {
        /* 사전 검사 실패는 조용히 넘긴다 — 제출 시 서버가 다시 검사한다 */
      }
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, enough]);

  // 지금 입력에 대한 결과가 아직 없으면 아무것도 그리지 않는다
  if (!enough || result?.key !== key) return null;
  const { findings, rates } = result;

  if (findings.length === 0) {
    return (
      <p className={styles.hint} style={{ marginTop: 8 }}>
        ✓ 명백한 금지 표현은 발견되지 않았습니다. 최종 판단은 제출 후 검수에서 이뤄집니다.
      </p>
    );
  }

  const blocking = findings.some((f) => f.severity === "BLOCK");

  return (
    <div
      style={{
        marginTop: 10,
        padding: "10px 12px",
        borderRadius: 10,
        borderLeft: `4px solid ${blocking ? "var(--neg)" : "var(--warn)"}`,
        background: `color-mix(in srgb, ${blocking ? "var(--neg)" : "var(--warn)"} 6%, var(--bg))`,
      }}
    >
      <p style={{ margin: 0, fontWeight: 700, fontSize: 13.5 }}>
        {blocking
          ? "이대로 제출하면 게시가 거절됩니다"
          : "이대로 제출하면 게시가 보류되고 운영자 검토를 기다리게 됩니다"}
      </p>
      <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13 }}>
        {findings.map((f, i) => {
          const rate = rates[f.category];
          return (
            <li key={i} style={{ marginBottom: 6, color: "var(--text-weak)" }}>
              <strong>{RISK_CATEGORY_LABEL[f.category]}</strong>
              {f.severity === "BLOCK" && (
                <span style={{ color: "var(--neg)", fontWeight: 700 }}> · 금지</span>
              )}
              {" — "}
              {f.reason}
              <br />
              <span style={{ color: "var(--text-faint)" }}>&ldquo;{f.quote}&rdquo;</span>
              {/* 오탐이 잦은 유형까지 똑같이 겁을 주면 경고 전체가 무시된다 —
                  겁주기 대신 실제 결과를 덧붙여 강도를 정직하게 조절한다 */}
              {f.severity === "WARN" && rate && rate.approved > 0 && (
                <>
                  <br />
                  <span style={{ color: "var(--text-faint)" }}>
                    참고: 이 유형으로 보류된 최근 {rate.flagged}건 중 {rate.approved}건은 검토 후
                    게시가 승인됐습니다.
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
