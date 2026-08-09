"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, PREPAYMENT_RATIOS, type AssetClass } from "@/domain/constants";
import { PRICE_GUIDE_KRW, REPORT_TEXT_LIMITS } from "@/domain/publishReport";
import {
  instrumentRiskReasons,
  RISK_LEVEL_LABEL,
  type RiskLevel,
} from "@/domain/instrumentRisk";
import { salesWindowEnd } from "@/domain/salesWindow";
import { MIN_MAGNITUDE_PCT } from "@/domain/scoring";
import { ScoreCalculatorEntry } from "../../../score/ScoreCalculatorEntry";
import { confidenceStars, stabilityStars, StarRating } from "../../../StarRating";
import styles from "../../researcher.module.css";
import { ComplianceHints } from "./ComplianceHints";

const RATING = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

const toNumber = (v: string): number | null => {
  const n = Number(v);
  return v.trim() && Number.isFinite(n) ? n : null;
};

/** 검증 시한까지 남은 일수 — 크기 상한은 기간과 함께 봐야 판단된다 */
/** 판매 기간 미리보기 문구 — 시한 입력 순간(이벤트)에만 계산한다 (렌더 순수성) */
const salesWindowLabel = (deadline: string): string | null => {
  if (!deadline) return null;
  const d = new Date(deadline);
  if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return null;
  const ms = salesWindowEnd(new Date(), d).getTime() - Date.now();
  return ms >= 86_400_000
    ? `약 ${Math.round(ms / 86_400_000)}일`
    : `약 ${Math.max(1, Math.round(ms / 3_600_000))}시간`;
};

const toHorizonDays = (deadline: string): number | null => {
  if (!deadline) return null;
  const at = new Date(deadline).getTime();
  if (!Number.isFinite(at)) return null;
  return (at - Date.now()) / 86_400_000;
};

interface InstrumentHit {
  ticker: string;
  name: string;
  shortable: boolean;
  riskLevel: RiskLevel;
  riskNote: string | null;
  delistingRisk: boolean;
  marketCap: number | null;
}

export function ReportForm({ researcherId }: { researcherId: string }) {
  const router = useRouter();
  const [assetClass, setAssetClassState] = useState<AssetClass>("KR_EQUITY");
  const [direction, setDirection] = useState("UP");
  const [targetType, setTargetType] = useState("RETURN_PCT");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // 글자 수를 실시간으로 보여주기 위해 제어 컴포넌트로 관리 (상한은 도메인 상수)
  const [title, setTitle] = useState("");
  // 예측 카드 수치도 상태로 둔다 — 작성 중 사전 검사가 크기·기간을 함께 봐야 하기 때문
  const [targetValue, setTargetValue] = useState("");
  const [deadline, setDeadline] = useState("");
  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [confidence, setConfidence] = useState("5");
  const [selfStability, setSelfStability] = useState("1");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");

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

  // 선택한 종목이 게시 보류를 유발하는지 (도메인 규칙 그대로 — 서버 판정과 어긋나지 않게)
  const selectedRiskReasons = selected
    ? instrumentRiskReasons({
        assetClass,
        riskLevel: selected.riskLevel,
        riskNote: selected.riskNote,
        delistingRisk: selected.delistingRisk,
        marketCap: selected.marketCap,
      })
    : [];

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
        <input
          className={styles.input}
          name="title"
          required
          maxLength={REPORT_TEXT_LIMITS.title}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <span className={styles.hint}>
          {title.length}/{REPORT_TEXT_LIMITS.title}자
        </span>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>요약 (구매 전 공개)</label>
        <input
          className={styles.input}
          name="summary"
          required
          maxLength={REPORT_TEXT_LIMITS.summary}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
        <span className={styles.hint}>
          {summary.length}/{REPORT_TEXT_LIMITS.summary}자 · 구매 전 공개되는 미리보기입니다
        </span>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>본문 (유료 · 예측 근거)</label>
        <textarea
          className={styles.textarea}
          name="content"
          required
          maxLength={REPORT_TEXT_LIMITS.content}
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
        <span className={styles.hint}>
          {content.length}/{REPORT_TEXT_LIMITS.content}자 · 결론은 예측 카드가 담으므로 본문은
          근거를 압축해 작성해주세요
        </span>
        {/* 1차 검수(규칙 + 학습 표현)를 작성 중에 미리 돌려 보여준다 —
            제출 후에야 알게 되면 AI 검수 비용·운영자 판단·리서처 대기가 전부 낭비된다 */}
        <ComplianceHints
          input={{
            title,
            summary,
            content,
            assetClass,
            assetName: selected?.name ?? "",
            direction,
            riskLevel: selected?.riskLevel,
            riskNote: selected?.riskNote,
            delistingRisk: selected?.delistingRisk,
            marketCap: selected?.marketCap,
            targetType,
            magnitudePct: targetType === "RETURN_PCT" ? toNumber(targetValue) : null,
            horizonDays: toHorizonDays(deadline),
            confidence: toNumber(confidence),
          }}
        />
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
                    {h.riskLevel !== "NONE" && (
                      <span
                        className={`${styles.badge} ${
                          h.riskLevel === "WARNING" ? styles.miss : styles.undecidable
                        }`}
                        style={{ marginLeft: 6 }}
                      >
                        {RISK_LEVEL_LABEL[h.riskLevel]}
                      </span>
                    )}
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
          {/* 위험 종목이면 게시가 보류된다는 사실을 작성 전에 알린다 */}
          {selectedRiskReasons.length > 0 && (
            <span className={styles.hint} style={{ color: "var(--neg)", fontWeight: 600 }}>
              이 종목은 게시 시 <u>운영자 검토를 거쳐야 판매가 시작됩니다</u>:{" "}
              {selectedRiskReasons.map((r) => r.message).join(" ")}
              {selected?.riskLevel === "WARNING" &&
                " 본문에 변동성·거래 제한 위험을 함께 설명해주세요."}
            </span>
          )}
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
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
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
        <input
          className={styles.input}
          name="deadline"
          type="datetime-local"
          required
          value={deadline}
          onChange={(e) => {
            setDeadline(e.target.value);
            setWindowLabel(salesWindowLabel(e.target.value));
          }}
        />
        <span className={styles.hint}>
          코인 최소 1일 / 국내주식 개장 전 게시 시 당일, 그 외 +2일 / 미국주식 +2일 · 최대 365일
        </span>
        {/* 판매 기간 고지 — 게시를 누르기 전에 알아야 하는 조건이라 여기서 미리 보여준다.
            시한을 바꾸면 판매 기간이 따라 바뀌는 것이 눈에 보여야 "1/3 규칙"이 학습된다 */}
        {windowLabel && (
          <span className={styles.hint}>
            <strong>판매 기간: 게시 후 {windowLabel}</strong> (검증 기간의 1/3, 최대 30일) —
            이후엔 판매가 자동 마감되고 카드는 시한에 정상 판정됩니다. 목표에 근접하면(잔여
            수익률이 구간 최소치의 2/3 미만 종가) 더 일찍 마감될 수 있습니다.
          </span>
        )}
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>신뢰도 (점수 증폭 1~10)</label>
          <select
            className={styles.select}
            name="confidence"
            value={confidence}
            onChange={(e) => setConfidence(e.target.value)}
          >
            {RATING.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className={styles.hint}>높을수록 적중 시 배점↑·실패 시 벌점↑</span>
          {/* 별점 미리보기 — "3을 골랐는데 왜 별 3.75개?"라는 물음이 생기기 전에,
              고르는 바로 그 자리에서 표시 규칙(함의 승률 × 5)을 보여준다 */}
          {(() => {
            const c = toNumber(confidence)!;
            return (
              <span className={styles.hint}>
                구매자 화면 표시: <StarRating stars={confidenceStars(c)} label="신뢰도" />{" "}
                {confidenceStars(c).toFixed(2)}개 — 별점은 다이얼값이 아니라 이 신고가
                함의하는 최소 승률({Math.round((100 * c) / (c + 1))}%)입니다
              </span>
            );
          })()}
        </div>
        <div className={styles.field}>
          <label className={styles.label}>안정성 (자기평가 1~10)</label>
          <select
            className={styles.select}
            name="selfStability"
            value={selfStability}
            onChange={(e) => setSelfStability(e.target.value)}
          >
            {RATING.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <span className={styles.hint}>
            정밀도 배팅 — 실현이 예측 수익률에 가까울수록 가점, 멀수록 감점 (초과는 관대). 1은 불참
          </span>
          {(() => {
            const s = toNumber(selfStability)!;
            return (
              <span className={styles.hint}>
                구매자 화면 표시:{" "}
                {s <= 1 ? (
                  <>별 0개 — 불참은 아무 확률도 걸지 않은 상태라 빈 별로 나갑니다</>
                ) : (
                  <>
                    <StarRating stars={stabilityStars(s)} label="안정성" />{" "}
                    {stabilityStars(s).toFixed(2)}개 — 함의 정밀 착지율{" "}
                    {Math.round((100 * (s - 1)) / s)}%
                  </>
                )}
              </span>
            );
          })()}
        </div>
        {/* 수익성은 예측 수익률에서 자동 산출된다 — 입력 항목이 아니다 */}
      </div>

      {/* 설명이 필요한 지점과 설명이 있는 지점을 같게 — 두 값을 고르는 바로 그 자리 */}
      <ScoreCalculatorEntry
        title="이 설정이면 몇 점을 따고 잃나요?"
        sub="신뢰도·안정성을 바꿔 가며 실제 채점 결과를 미리 확인해 보세요"
      />

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
