"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, PREPAYMENT_RATIOS, type AssetClass } from "@/domain/constants";
import { PRICE_GUIDE_KRW } from "@/domain/publishReport";
import { MIN_MAGNITUDE_PCT } from "@/domain/scoring";
import styles from "../../researcher.module.css";

const RATING = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function ReportForm({ researcherId }: { researcherId: string }) {
  const router = useRouter();
  const [assetClass, setAssetClass] = useState<AssetClass>("KR_EQUITY");
  const [targetType, setTargetType] = useState("RETURN_PCT");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const sizeFloor = MIN_MAGNITUDE_PCT[assetClass];
  const tickerHint =
    assetClass === "KR_EQUITY"
      ? "6자리 코드 (예: 005930)"
      : assetClass === "US_EQUITY"
        ? "심볼 (예: AAPL)"
        : "업비트 마켓코드 (예: KRW-BTC)";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErrors([]);
    const f = new FormData(e.currentTarget);
    const num = (k: string) => Number(f.get(k));

    const payload = {
      title: f.get("title"),
      summary: f.get("summary"),
      content: f.get("content"),
      priceKrw: num("priceKrw"),
      prepaymentRatio: num("prepaymentRatio"),
      card: {
        assetClass,
        ticker: f.get("ticker"),
        assetName: f.get("assetName"),
        direction: f.get("direction"),
        targetType,
        targetValue: num("targetValue"),
        deadline: new Date(String(f.get("deadline"))).toISOString(),
        confidence: num("confidence"),
        selfStability: num("selfStability"),
        selfProfitability: num("selfProfitability"),
      },
    };

    try {
      const res = await fetch("/api/reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) {
        setErrors(body.issues?.map(String) ?? [body.error ?? "저장 실패"]);
        return;
      }
      router.push(`/researcher/${researcherId}`);
      router.refresh();
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label className={styles.label}>리포트 제목</label>
        <input className={styles.input} name="title" required maxLength={200} />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>요약 (구매 전 공개)</label>
        <input className={styles.input} name="summary" required maxLength={2000} />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>본문 (유료 · 예측 근거)</label>
        <textarea className={styles.textarea} name="content" required />
      </div>

      <h3>예측 카드</h3>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>자산군</label>
          <select
            className={styles.select}
            value={assetClass}
            onChange={(e) => setAssetClass(e.target.value as AssetClass)}
          >
            {ASSET_CLASSES.map((a) => (
              <option key={a} value={a}>
                {ASSET_CLASS_LABEL[a]}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>종목/자산 코드</label>
          <input className={styles.input} name="ticker" required />
          <span className={styles.hint}>{tickerHint}</span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>종목명</label>
          <input className={styles.input} name="assetName" required />
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>방향</label>
          <select className={styles.select} name="direction" defaultValue="UP">
            <option value="UP">상승 (buy)</option>
            <option value="DOWN">하락 (sell)</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>크기 기준</label>
          <select
            className={styles.select}
            value={targetType}
            onChange={(e) => setTargetType(e.target.value)}
          >
            <option value="RETURN_PCT">목표 등락률(%)</option>
            <option value="TARGET_PRICE">목표가</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>
            {targetType === "RETURN_PCT" ? "목표 등락률(%)" : "목표가"}
          </label>
          <input
            className={styles.input}
            name="targetValue"
            type="number"
            step="any"
            required
          />
          {targetType === "RETURN_PCT" && (
            <span className={styles.hint}>
              {ASSET_CLASS_LABEL[assetClass]} 최소 크기 {sizeFloor}% 이상
            </span>
          )}
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>검증 시한</label>
        <input className={styles.input} name="deadline" type="datetime-local" required />
        <span className={styles.hint}>
          코인 최소 1일 / 국내주식 개장 전 게시 시 당일, 그 외 +2일 / 미국주식 +2일 · 최대 365일
        </span>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>신뢰도 (점수 증폭 1~10)</label>
          <select className={styles.select} name="confidence" defaultValue="5">
            {RATING.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className={styles.hint}>높을수록 적중 시 배점↑·실패 시 벌점↑</span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>안정성 (자기평가 1~10)</label>
          <select className={styles.select} name="selfStability" defaultValue="5">
            {RATING.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>수익성 (자기평가 1~10)</label>
          <select className={styles.select} name="selfProfitability" defaultValue="5">
            {RATING.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      <h3>판매 조건</h3>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>가격 (원)</label>
          <input
            className={styles.input}
            name="priceKrw"
            type="number"
            defaultValue={10000}
            required
          />
          <span className={styles.hint}>
            {PRICE_GUIDE_KRW.min.toLocaleString()}~{PRICE_GUIDE_KRW.max.toLocaleString()}원
          </span>
        </div>
        <div className={styles.field}>
          <label className={styles.label}>선결제 비율</label>
          <select className={styles.select} name="prepaymentRatio" defaultValue="0">
            {PREPAYMENT_RATIOS.map((r) => (
              <option key={r} value={r}>
                {r}%{r === 0 ? " (완전 성과 연동)" : ""}
              </option>
            ))}
          </select>
          <span className={styles.hint}>골드 등급부터 해금 (브론즈·실버는 0%만)</span>
        </div>
      </div>

      {errors.length > 0 && (
        <div className={styles.error}>
          작성 내용을 확인해주세요:
          <ul>
            {errors.map((msg, i) => (
              <li key={i}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.formActions}>
        <button className={styles.primaryBtn} type="submit" disabled={busy}>
          {busy ? "저장 중…" : "초안 저장"}
        </button>
        <span className={styles.hint}>저장 후 대시보드에서 게시하면 예측 카드가 잠깁니다.</span>
      </div>
    </form>
  );
}
