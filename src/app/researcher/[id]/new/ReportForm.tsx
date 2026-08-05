"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, PREPAYMENT_RATIOS, type AssetClass } from "@/domain/constants";
import { PRICE_GUIDE_KRW } from "@/domain/publishReport";
import { MIN_MAGNITUDE_PCT } from "@/domain/scoring";
import styles from "../../researcher.module.css";

const RATING = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

interface InstrumentHit {
  ticker: string;
  name: string;
  shortable: boolean;
}

export function ReportForm({ researcherId }: { researcherId: string }) {
  const router = useRouter();
  const [assetClass, setAssetClassState] = useState<AssetClass>("KR_EQUITY");
  const [direction, setDirection] = useState("UP");
  const [targetType, setTargetType] = useState("RETURN_PCT");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // 종목은 자유 입력이 아니라 종목 마스터(시세 공급자 유니버스) 검색·선택만 가능
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<InstrumentHit[]>([]);
  const [selected, setSelected] = useState<InstrumentHit | null>(null);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const shortOnly = direction === "DOWN";

  function runSearch(rawQuery: string, ac: AssetClass, shortOnlyFlag: boolean) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = rawQuery.trim();
    if (!q) {
      setHits([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({
          assetClass: ac,
          q,
          shortOnly: shortOnlyFlag ? "1" : "0",
        });
        const res = await fetch(`/api/instruments?${params}`);
        setHits(res.ok ? await res.json() : []);
      } catch {
        setHits([]);
      } finally {
        setSearching(false);
      }
    }, 250);
  }

  function onQueryChange(value: string) {
    setQuery(value);
    setSelected(null);
    runSearch(value, assetClass, shortOnly);
  }
  function pick(hit: InstrumentHit) {
    setSelected(hit);
    setQuery(`${hit.name} (${hit.ticker})`);
    setHits([]);
  }
  function clearSelection() {
    setSelected(null);
    setQuery("");
    setHits([]);
  }
  function setAssetClass(next: AssetClass) {
    setAssetClassState(next);
    if (next !== assetClass) clearSelection();
  }
  function onDirectionChange(next: string) {
    setDirection(next);
    const nextShortOnly = next === "DOWN";
    // 하락으로 전환 시 숏 불가 종목 선택은 해제, 검색 중이던 질의는 새 조건으로 재검색
    if (nextShortOnly && selected && !selected.shortable) clearSelection();
    else if (!selected && query.trim()) runSearch(query, assetClass, nextShortOnly);
  }

  const sizeFloor = MIN_MAGNITUDE_PCT[assetClass];
  const searchHint = shortOnly
    ? "하락 예측: 구매자가 숏 포지션(개별주식선물·인버스 ETF·코인 선물)을 잡을 수 있는 종목만 검색됩니다"
    : "시세 공급자가 지원하는 종목만 선택 가능 — 코드 또는 종목명으로 검색";

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) {
      setErrors(["종목을 검색해서 목록에서 선택해주세요"]);
      return;
    }
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
        ticker: selected.ticker,
        assetName: selected.name,
        direction,
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
        <div className={`${styles.field} ${styles.searchWrap}`}>
          <label className={styles.label}>종목/자산</label>
          <input
            className={styles.input}
            required
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="코드 또는 종목명 검색"
            autoComplete="off"
          />
          {hits.length > 0 && (
            <ul className={styles.searchResults}>
              {hits.map((h) => (
                <li key={h.ticker}>
                  <button type="button" className={styles.searchItem} onClick={() => pick(h)}>
                    <strong>{h.name}</strong> <span>{h.ticker}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {searching && <span className={styles.hint}>검색 중…</span>}
          {!searching && query.trim() && !selected && hits.length === 0 && (
            <span className={styles.hint}>검색 결과 없음 — 지원 종목만 선택할 수 있습니다</span>
          )}
          {(!query.trim() || selected) && <span className={styles.hint}>{searchHint}</span>}
        </div>
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>방향</label>
          <select
            className={styles.select}
            name="direction"
            value={direction}
            onChange={(e) => onDirectionChange(e.target.value)}
          >
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
          <select className={styles.select} name="selfStability" defaultValue="1">
            {RATING.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className={styles.hint}>
            정밀도 배팅 — 실현이 예측 수익률에 가까울수록 가점, 멀수록 감점 (초과는 관대). 1은 불참
          </span>
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
          <span className={styles.hint}>마스터 등급부터 해금 (무표기·시니어는 0%만)</span>
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
