"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, PREPAYMENT_RATIOS, type AssetClass } from "@/domain/constants";
import { PRICE_GUIDE_KRW, REPORT_TEXT_LIMITS, planBaseMode } from "@/domain/publishReport";
import {
  instrumentRiskReasons,
  RISK_LEVEL_LABEL,
  type RiskLevel,
} from "@/domain/instrumentRisk";
import { salesWindowEnd } from "@/domain/salesWindow";
import {
  claimedProbability,
  CONFIDENCE_RANGE,
  minMagnitudePct,
  noSkillTouchProbability,
} from "@/domain/scoring";
import { ScoreCalculatorEntry } from "../../../score/ScoreCalculatorEntry";
import { cardStabilityLevel } from "@/domain/stability";
import { confidenceStars, StarRating } from "../../../StarRating";
import styles from "../../researcher.module.css";
import { ComplianceHints } from "./ComplianceHints";

/**
 * 신뢰도 선택지 — 하한이 2다.
 * c=1은 승산 배수가 ×1.00, 즉 "내 확률 = 무정보 확률"이라는 신고라 정보량이 정확히 0이다:
 * 맞아도 0점, 틀려도 0점. 점수도 규율 래더도 닿지 못하는데 팔리기만 하는 칸이 된다
 * (§2.2 — 팔려면 점수를 걸어야 한다).
 */
const RATING = Array.from(
  { length: CONFIDENCE_RANGE.max - CONFIDENCE_RANGE.min + 1 },
  (_, i) => CONFIDENCE_RANGE.min + i,
);

const toNumber = (v: string): number | null => {
  const n = Number(v);
  return v.trim() && Number.isFinite(n) ? n : null;
};

/**
 * 지금 게시하면 이 카드가 목표가로만 써야 하는가 (DAY_CLOSE_AT_CLOSE) — 장중·장후·주말
 * 게시 <14일 주식은 게시 순간 기준가(종가)가 없어 %의 기준이 없다. 게시 관문(preparePublish)이
 * 실제로 강제하는 규칙과 같은 함수(planBaseMode)로 미리 알려, 제출 후 거절되는 대신
 * 작성 중에 목표가로 고정한다. now는 대략 게시 시각이라 미리보기이고, 진짜 판정은 게시 시점.
 */
const mustTargetPrice = (ac: AssetClass, deadlineStr: string): boolean => {
  if (!deadlineStr || ac === "CRYPTO") return false;
  const d = new Date(deadlineStr);
  if (Number.isNaN(d.getTime())) return false;
  try {
    return planBaseMode(ac, d, new Date()).baseMode === "DAY_CLOSE_AT_CLOSE";
  } catch {
    return false;
  }
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
  // 장중·장후 게시 <14일 주식이면 목표가로만 — 자산군/시한이 바뀔 때(이벤트) 다시 잰다
  const [forceTargetPrice, setForceTargetPrice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  // 글자 수를 실시간으로 보여주기 위해 제어 컴포넌트로 관리 (상한은 도메인 상수)
  const [title, setTitle] = useState("");
  // 예측 카드 수치도 상태로 둔다 — 작성 중 사전 검사가 크기·기간을 함께 봐야 하기 때문
  const [targetValue, setTargetValue] = useState("");
  const [deadline, setDeadline] = useState("");
  const [windowLabel, setWindowLabel] = useState<string | null>(null);
  const [confidence, setConfidence] = useState("5");
  const [summary, setSummary] = useState("");
  const [content, setContent] = useState("");

  // 종목은 자유 입력이 아니라 종목 마스터(시세 공급자 유니버스) 검색·선택만 가능
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<InstrumentHit[]>([]);
  const [selected, setSelected] = useState<InstrumentHit | null>(null);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 고른 종목의 실현 변동성 — p₀(정직 신뢰도의 기준)와 안정성 별점이 함께 쓰는 값.
  // 종목을 고르는 순간 부른다: 어떤 종목을 고르느냐가 배당을 바꾼다는 사실을
  // 고른 자리에서 바로 보여줘야 "거친 종목으로 hit만 노리는" 선택이 왜 손해인지 읽힌다
  const [sigmaDaily, setSigmaDaily] = useState<number | null>(null);
  const [sigmaLoading, setSigmaLoading] = useState(false);

  async function loadSigma(ac: AssetClass, ticker: string) {
    setSigmaLoading(true);
    try {
      const res = await fetch(
        `/api/instruments/sigma?${new URLSearchParams({ assetClass: ac, ticker })}`,
      );
      setSigmaDaily(res.ok ? ((await res.json()).sigmaDaily ?? null) : null);
    } catch {
      setSigmaDaily(null);
    } finally {
      setSigmaLoading(false);
    }
  }

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
    void loadSigma(assetClass, hit.ticker);
  }
  function clearSelection() {
    setSelected(null);
    setQuery("");
    setHits([]);
    setSigmaDaily(null);
  }
  // 자산군·시한이 바뀔 때 "목표가만" 여부를 다시 잰다(렌더가 아니라 이벤트에서).
  function refreshBaseModeHint(ac: AssetClass, deadlineStr: string) {
    const force = mustTargetPrice(ac, deadlineStr);
    setForceTargetPrice(force);
    if (force) setTargetType("TARGET_PRICE");
  }
  function setAssetClass(next: AssetClass) {
    setAssetClassState(next);
    if (next !== assetClass) clearSelection();
    refreshBaseModeHint(next, deadline);
  }
  function onDirectionChange(next: string) {
    setDirection(next);
    const nextShortOnly = next === "DOWN";
    // 하락으로 전환 시 숏 불가 종목 선택은 해제, 검색 중이던 질의는 새 조건으로 재검색
    if (nextShortOnly && selected && !selected.shortable) clearSelection();
    else if (!selected && query.trim()) runSearch(query, assetClass, nextShortOnly);
  }

  // 고른 종목이 받게 될 안정성 별 — 게시 후 카드에 그대로 붙는다
  const stabilityPreview = cardStabilityLevel(sigmaDaily);

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

  // 크기 하한은 **고른 종목과 기한**으로 정해진다 — 서버 검증과 같은 함수를 부른다.
  // 기한을 아직 안 정했으면 30일로 미리 보여준다(값이 없다고 칸을 비우면 무엇을
  // 적어야 할지 알 수 없다). 기한을 고르는 순간 이 숫자가 따라 움직인다
  const sizeFloor = minMagnitudePct(assetClass, sigmaDaily, toHorizonDays(deadline) ?? 30);
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
        // 안정성은 점수 v4에서 제거 — 스키마 호환용 최솟값(불참)만 보낸다
        selfStability: 1,
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
            sigmaDaily,
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
            disabled={forceTargetPrice}
          >
            {!forceTargetPrice && <option value="RETURN_PCT">목표 등락률(%)</option>}
            <option value="TARGET_PRICE">목표가</option>
          </select>
          {forceTargetPrice && (
            <span className={styles.hint}>
              장중·장후 게시 단기(14일 미만) 주식은 <strong>목표가로만</strong> 씁니다 — 게시
              순간엔 기준가(종가)가 없어 수익률(%)의 기준이 없습니다. 장 마감 후 종가로
              기준가가 확정되면 목표%가 정해지고 그때 판매가 시작됩니다.
            </span>
          )}
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
              최소 크기 {sizeFloor.toFixed(1)}% 이상
              {sigmaDaily !== null
                ? ` — 이 종목의 변동성(하루 ${(sigmaDaily * 100).toFixed(1)}%)과 기한으로 정해집니다. 저절로 닿을 만한 크기는 예측으로 치지 않습니다`
                : ` — ${ASSET_CLASS_LABEL[assetClass]} 평균 변동성 기준 (종목을 고르면 그 종목 기준으로 바뀝니다)`}
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
            refreshBaseModeHint(assetClass, e.target.value);
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
            이후엔 판매가 자동 마감되고 카드는 시한에 정상 판정됩니다. 그 전에도 판매가
            끝나는 경우가 있습니다: 일봉 종가가 <strong>목표에 도달</strong>하면 그 자리에서
            판정되고, 반대로 <strong>목표 폭만큼 어긋나면</strong>(일봉 종가 기준) 판매가
            영구 마감됩니다. 카드는 어느 경우에도 그대로 검증되어 판정됩니다.
          </span>
        )}
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label}>
            신뢰도 (적중 확률 신고 {CONFIDENCE_RANGE.min}~{CONFIDENCE_RANGE.max})
          </label>
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
          <span className={styles.hint}>
            신뢰도는 <b>적중 확률 신고</b>입니다 — 한 칸 올릴 때마다 무정보 대비 승산이
            ×1.73, 꼭대기(10)가 ×140. 믿는 그대로 적는 것이 기대 점수가 가장 큽니다
            (부풀려도 낮춰도 손해입니다)
          </span>
          {/* 정직 신뢰도 가이드 — 지금 적은 사양(방향·크기·기간)의 무정보 도달 확률과
              그 위에서 이 신뢰도가 신고하게 되는 확률을 그 자리에서 보여준다.
              채점이 쓰는 claimedProbability를 그대로 부른다 */}
          {(() => {
            const m = targetType === "RETURN_PCT" ? toNumber(targetValue) : null;
            const h = toHorizonDays(deadline);
            if (m === null || m <= 0 || h === null || h <= 0) return null;
            const p0 = noSkillTouchProbability(
              direction === "DOWN" ? "DOWN" : "UP",
              m,
              assetClass,
              h,
              // **고른 종목의 실제 변동성**으로 잰다 — 자산군 평균으로 재면 거친 종목이
              // 실제보다 어려운 사양으로 계산돼, 변동성만으로 hit을 노리는 길이 열린다
              sigmaDaily,
            );
            return (
              <span className={styles.hint}>
                이 사양은 아무 정보 없이 찍어도 {Math.round(p0 * 100)}% 확률로 닿습니다 —
                지금 고른 신뢰도 {toNumber(confidence)}이면{" "}
                <b>
                  적중 확률{" "}
                  {Math.round(claimedProbability(p0, toNumber(confidence)!) * 100)}%
                </b>
                를 신고하는 것과 같습니다. 이보다 자주 맞힐 자신이 있을 때만 남는 장사입니다
                {sigmaDaily !== null ? (
                  <>
                    {" "}
                    (이 종목의 최근 변동성 하루 {(sigmaDaily * 100).toFixed(1)}% 기준 —
                    출렁이는 종목일수록 그냥 닿을 확률이 커서 적중 보상이 줄어듭니다)
                  </>
                ) : sigmaLoading ? (
                  <> (종목 변동성 측정 중…)</>
                ) : (
                  <> (종목 변동성을 아직 못 재 자산군 평균으로 계산했습니다)</>
                )}
              </span>
            );
          })()}
          {/* 별점 미리보기 — 고르는 바로 그 자리에서 구매자가 볼 별을 보여준다.
              vmax에서 별은 다이얼값에 선형이라 규칙 설명이 짧아졌다(별 한 칸 = 승산 ×1.73) */}
          {(() => {
            const c = toNumber(confidence)!;
            return (
              <span className={styles.hint}>
                구매자 화면 표시: <StarRating stars={confidenceStars(c)} label="신뢰도" />{" "}
                {confidenceStars(c).toFixed(1)}개 — 별 한 칸이 승산 ×1.73입니다
              </span>
            );
          })()}
        </div>
        {/* 안정성은 자기 신고 다이얼이 아니라 **종목 변동성으로 시스템이 매긴다** —
            리서처는 고르는 것이지 신고하는 것이 아니다. 그래서 입력칸 대신
            "고른 종목이 받게 될 별"을 미리 보여준다 */}
        {selected && (
          <div className={styles.field}>
            <label className={styles.label}>안정성 (자동 산정)</label>
            {stabilityPreview === null ? (
              <span className={styles.hint}>
                {sigmaLoading
                  ? "종목 변동성 측정 중…"
                  : "이 종목은 최근 변동성을 재지 못해 별점이 표시되지 않습니다 (상장 초기 등)"}
              </span>
            ) : (
              <span className={styles.hint}>
                <StarRating stars={stabilityPreview} label="안정성" /> — 최근 120거래일
                실현 변동성(하루 {(sigmaDaily! * 100).toFixed(1)}%) 기준입니다. 점수에는
                반영되지 않고, 같은 값이 위 도달 확률 계산에 쓰입니다
              </span>
            )}
          </div>
        )}
        {/* 수익성은 예측 수익률에서 자동 산출된다 — 입력 항목이 아니다 */}
      </div>

      {/* 설명이 필요한 지점과 설명이 있는 지점을 같게 — 두 값을 고르는 바로 그 자리 */}
      <ScoreCalculatorEntry
        title="이 설정이면 몇 점을 따고 잃나요?"
        sub="크기·기간·신뢰도를 바꿔 가며 실제 채점 결과를 미리 확인해 보세요"
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
