"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import styles from "../../researcher/researcher.module.css";

// 수동 판정 폼: 카드 유형에 맞는 시세만 입력받는다.
// - RETURN_PCT: 시한 종가 (+ 소급 카드는 기준가)
// - TARGET_PRICE 상승: 기간 최고가 / 하락: 기간 최저가
// 판정 불가 처리 시에는 사유 코드를 고른다. 서술 사유는 항상 필수.

const UNDECIDABLE_OPTIONS = [
  { value: "TRADING_HALT", label: "거래정지" },
  { value: "DELISTED", label: "상장폐지" },
  { value: "AMBIGUOUS", label: "판정 불능 (데이터 없음·조건 모호)" },
] as const;

export function ManualJudgeForm({
  cardId,
  targetType,
  direction,
  needsBasePrice,
}: {
  cardId: string;
  targetType: string;
  direction: string;
  needsBasePrice: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"PRICE" | "UNDECIDABLE">("PRICE");
  const [price, setPrice] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [undecidableReason, setUndecidableReason] = useState<string>("AMBIGUOUS");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priceLabel =
    targetType === "RETURN_PCT"
      ? "시한 종가"
      : direction === "UP"
        ? "기간 최고가"
        : "기간 최저가";

  async function submit(recheckToken?: string) {
    setBusy(true);
    setError(null);
    try {
      const decision =
        mode === "UNDECIDABLE"
          ? { type: "UNDECIDABLE", undecidableReason }
          : {
              type: "PRICE",
              // 판정 규칙 통합(2026-08-10): 유형과 무관하게 "기간 중 종가 극값"으로
              // 도달을 판정한다. 운영자가 값 하나를 입력하면 극값이자 시한 종가로 쓴다
              // (더 아는 것이 없을 때의 보수 기본값 — manualJudgmentService와 같은 규칙)
              ...(direction === "UP"
                ? { maxCloseSincePublish: Number(price), priceAtDeadline: Number(price) }
                : { minCloseSincePublish: Number(price), priceAtDeadline: Number(price) }),
              ...(needsBasePrice && basePrice ? { basePrice: Number(basePrice) } : {}),
            };
      const res = await fetch("/api/admin/judgments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId, reason, decision, recheckToken }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 1인 운영 모드 — 두 번째 사람 대신 지문·얼굴이 선다. 받은 표를 실어 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await submit(recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
          return;
        }
        setError(body.error ?? "판정 실패");
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.form}>
      <div className={styles.row}>
        <label className={styles.field}>
          <span className={styles.label}>처리 방식</span>
          <select
            className={styles.select}
            value={mode}
            onChange={(e) => setMode(e.target.value as "PRICE" | "UNDECIDABLE")}
          >
            <option value="PRICE">시세 입력 판정</option>
            <option value="UNDECIDABLE">판정 불가 (전액 환불)</option>
          </select>
        </label>

        {mode === "PRICE" ? (
          <>
            <label className={styles.field}>
              <span className={styles.label}>{priceLabel}</span>
              <input
                className={styles.input}
                type="number"
                min="0"
                step="any"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="검증된 시세"
              />
            </label>
            {needsBasePrice && (
              <label className={styles.field}>
                <span className={styles.label}>기준가 (소급 확정)</span>
                <input
                  className={styles.input}
                  type="number"
                  min="0"
                  step="any"
                  value={basePrice}
                  onChange={(e) => setBasePrice(e.target.value)}
                  placeholder="게시 시점 규칙상 기준가"
                />
              </label>
            )}
          </>
        ) : (
          <label className={styles.field}>
            <span className={styles.label}>판정 불가 사유</span>
            <select
              className={styles.select}
              value={undecidableReason}
              onChange={(e) => setUndecidableReason(e.target.value)}
            >
              {UNDECIDABLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <label className={styles.field}>
        <span className={styles.label}>수동 판정 사유 (감사 기록, 필수)</span>
        <textarea
          className={styles.textarea}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="예: 공급자 API 결측 — 거래소 공시 종가로 확인 (URL)"
        />
      </label>

      <div className={styles.formActions}>
        <button
          className={styles.primaryBtn}
          onClick={() => submit()}
          disabled={busy || !reason.trim() || (mode === "PRICE" && !price)}
        >
          {busy ? "판정 중…" : mode === "PRICE" ? "판정 실행" : "판정 불가 처리"}
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
