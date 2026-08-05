"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ASSET_CLASSES, ASSET_CLASS_LABEL, type AssetClass } from "@/domain/constants";
import { squarify } from "@/lib/treemap";
import type { ConsensusRow } from "@/server/marketQueries";
import cryptoSnapshot from "../data/crypto-heatmap.json";
import kospi from "../data/kospi-heatmap.json";
import usSnapshot from "../data/us-heatmap.json";
import { heatmapMeta } from "./heatmapMeta";
import { StockLogo } from "./StockLogo";
import styles from "./page.module.css";

// 예측 히트맵 — 확정 규칙 (중첩 트리맵으로 전부 충족):
//  · 코스피 박스(전체 캔버스)는 사각형이고, 오직 섹터 박스들로만 구성된다 (빈틈 0)
//  · 섹터 박스는 오직 종목 박스들로만 구성된다 (빈틈 0)
//  · 종목·섹터 박스 면적 ∝ 시가총액, 모양은 정사각형에 최대한 가깝게 (squarified —
//    크기 비례 완전 정사각형만으로는 빈틈 없이 채우는 것이 수학적으로 불가능해서,
//    "빈틈 0"을 우선하고 정사각형은 최대한 근접으로 지킨다)
//  · 코스피 전 종목 포함 (src/data/kospi-heatmap.json — KRX 상장 주식 스냅샷,
//    ETF·ETN 제외·우선주 포함. 미국주식·코인 탭은 데모 유니버스)
//  · 박스가 과도하게 작으면 종목 정보 없이 색만 (호버·스크린리더로는 확인 가능)
// 색은 우리 예측 데이터 — 검증 중 컨센서스 방향(상승 초록/하락 빨강/팽팽 진회색),
// 예측 없는 종목은 연회색. 시세·외부 API 호출이 없는 정적 스냅샷 기반이다.

/**
 * 우세율로 색을 정한다 (확정 — 구 V2): 상승 초록(120°)/하락 빨강(0°) 계열에서
 * 명도는 고정하고 **채도만 연속 변화** — 우세율 50%(팽팽 직후)면 회색빛,
 * 100%면 완전 포화. 팽팽(50:50)은 무채색 회색, 예측 없는 종목은 연회색.
 */
function tileStyle(row: ConsensusRow | undefined): { background: string; color: string } {
  if (!row) return { background: "hsl(220 14% 91%)", color: "#565d69" };
  const share = Math.max(row.up, row.down) / row.total;
  const t = Math.max(0, Math.min(1, (share - 0.5) * 2));
  const s = Math.round(15 + 85 * t);
  if (row.lean === "UP") return { background: `hsl(120 ${s}% 40%)`, color: "#fff" };
  if (row.lean === "DOWN") return { background: `hsl(0 ${s}% 47%)`, color: "#fff" };
  return { background: "hsl(220 10% 81%)", color: "#3d434d" };
}

/** 타일 표기용 우세율 — ▲75%(상승 우세)·▼100%(하락 우세)·50%(팽팽).
 *  +/−가 아니라 ▲/▼를 쓰는 이유: 주식 히트맵에서 ±%는 등락률로 읽히기 때문 */
function consensusLabel(row: ConsensusRow): string {
  const share = Math.round((Math.max(row.up, row.down) / row.total) * 100);
  if (row.lean === "UP") return `▲${share}%`;
  if (row.lean === "DOWN") return `▼${share}%`;
  return `${share}%`;
}

// 실제 폭은 유동이라 데스크톱 컨테이너 폭(최대 720 − 패딩) 근사치로
// 종횡비·타일 크기 단계를 계산한다. 모바일에서는 다소 어긋나지만 충분히 가깝다.
const CANVAS_W = 680;
const SECTOR_LABEL_H = 20; // 구획 라벨 스트립 높이(px) — 타일 영역에서 빠지는 몫

/**
 * 타일의 대략적 픽셀 면적으로 표시 단계를 나눈다.
 * 큰 타일 = 로고+이름+건수, 작아질수록 이름→색만 남긴다 (과소 박스 = 색만 규칙).
 */
function sizeClass(pxArea: number): string {
  if (pxArea >= 24_000) return styles.heatTileXl;
  if (pxArea >= 9_000) return styles.heatTileLg;
  if (pxArea >= 3_000) return styles.heatTileMd;
  return styles.heatTileSm;
}

interface Tile {
  ticker: string;
  name: string;
  sector: string;
  cap: number;
  row?: ConsensusRow;
}

interface SectorGroup {
  sector: string;
  tiles: Tile[];
  cap: number;
}

export function PredictionHeatmap({ consensus }: { consensus: ConsensusRow[] }) {
  const byClass = new Map<AssetClass, ConsensusRow[]>();
  for (const row of consensus) {
    const key = row.assetClass as AssetClass;
    const list = byClass.get(key) ?? [];
    list.push(row);
    byClass.set(key, list);
  }

  // 자산군 인라인 드롭다운 개폐 — 시트·팝업 없이 버튼 자리에서 바로 펼친다.
  // 바깥 클릭·Escape로 닫는다 (드롭다운 영역은 data 속성으로 구분)
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => {
    if (!pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest("[data-heat-asset-picker]")) {
        setPickerOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  // 첫 표시는 활성 예측이 가장 많은 자산군
  const [selected, setSelected] = useState<AssetClass>(() => {
    let best: AssetClass = ASSET_CLASSES[0];
    let bestTotal = -1;
    for (const [assetClass, rows] of byClass) {
      const total = rows.reduce((s, r) => s + r.total, 0);
      if (total > bestTotal) {
        best = assetClass;
        bestTotal = total;
      }
    }
    return best;
  });

  const rows = byClass.get(selected) ?? [];
  const rowByTicker = new Map(rows.map((r) => [r.ticker, r]));

  // 자산군별 전 종목 스냅샷: 국내주식 = 코스피, 미국주식 = S&P 500,
  // 코인 = 업비트 KRW 마켓 거래 가능 종목 (모두 같은 형식)
  const snapshot =
    selected === "KR_EQUITY"
      ? kospi.stocks
      : selected === "US_EQUITY"
        ? usSnapshot.stocks
        : cryptoSnapshot.stocks;
  const tiles: Tile[] = snapshot.map((s) => ({
    ticker: s.code,
    name: s.name,
    sector: s.sector,
    cap: s.capT,
    row: rowByTicker.get(s.code),
  }));
  // 유니버스 밖인데 예측은 있는 종목 합류 (상폐 직전 등 경계 사례)
  for (const r of rows) {
    if (!tiles.some((t) => t.ticker === r.ticker)) {
      const meta = heatmapMeta(selected, r.ticker);
      tiles.push({
        ticker: r.ticker,
        name: meta?.name ?? r.assetName,
        sector: meta?.sector ?? "기타",
        cap: meta?.capTrillionKrw ?? 1,
        row: r,
      });
    }
  }

  // 너무 작은 회사는 뺀다 (확정 — 실낱 타일이 섹터 내부를 지저분하게 만들어서).
  // 기준: 캔버스에서 차지할 면적이 약 10px 변 미만. 활성 예측이 있는 종목은 작아도 남긴다.
  const allCap = tiles.reduce((s, t) => s + t.cap, 0);
  const pxPerCap = allCap > 0 ? (CANVAS_W * 560) / allCap : 0; // 높이는 상한 근사
  const visible = tiles.filter((t) => t.row || t.cap * pxPerCap >= 100);

  // 섹터 구획: 구획 면적 = 섹터 시총 합 (코스피 박스를 빈틈 없이 나눈다)
  const sectors = new Map<string, SectorGroup>();
  for (const tile of visible) {
    const group = sectors.get(tile.sector) ?? { sector: tile.sector, tiles: [], cap: 0 };
    group.tiles.push(tile);
    group.cap += tile.cap;
    sectors.set(tile.sector, group);
  }
  const sectorList = [...sectors.values()].sort((a, b) => b.cap - a.cap);

  // 캔버스 기준 높이(데스크톱 폭 기준): 종목·섹터 수에 비례, 전체가 한 화면에.
  // aspect-ratio로 그려 폭이 좁아지면 높이도 비례해 줄고 75% 아래로는 안 내려간다
  const height = Math.max(
    280,
    Math.min(560, 200 + Math.round(visible.length * 0.3) + sectorList.length * 16),
  );

  const sectorRects = squarify(
    sectorList.map((g) => ({ item: g, value: g.cap })),
    CANVAS_W / height,
  );

  return (
    <div>
      {/* 섹션 머리 — "[국내주식 ▼] 예측 히트맵" 형태. 자산군 버튼이 제목 맨 앞이고,
          누르면 ▼가 ▲로 바뀌며 그 자리 아래로 나머지 항목이 인라인 드롭다운으로 펼쳐진다 */}
      <div className={styles.sectionHead}>
        <span className={styles.heatHeadLeft}>
          <span className={styles.heatAssetWrap} data-heat-asset-picker>
            <button
              type="button"
              className={styles.heatAssetBtn}
              onClick={() => setPickerOpen((o) => !o)}
              aria-expanded={pickerOpen}
              aria-label={`자산군 선택 — 현재 ${ASSET_CLASS_LABEL[selected]}`}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                className={pickerOpen ? styles.heatAssetChevronUp : undefined}
              >
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span data-heat-asset-label>{ASSET_CLASS_LABEL[selected]}</span>
            </button>
            {pickerOpen && (
              <div className={styles.heatAssetMenu}>
                {ASSET_CLASSES.filter((a) => a !== selected).map((assetClass) => (
                  <button
                    key={assetClass}
                    type="button"
                    className={styles.heatAssetOption}
                    onClick={() => {
                      setSelected(assetClass);
                      setPickerOpen(false);
                    }}
                  >
                    {ASSET_CLASS_LABEL[assetClass]}
                  </button>
                ))}
              </div>
            )}
          </span>
          <span className={styles.sectionTitle}>예측 히트맵</span>
        </span>
        <Link href="/leaderboard" className={styles.sectionMore}>
          카드 보기 →
        </Link>
      </div>
      <div
        className={`${styles.heatWrap} ${styles.heatCanvas}`}
        style={
          visible.length === 0
            ? { height: 120 }
            : {
                width: "100%",
                aspectRatio: `${CANVAS_W} / ${height}`,
                minHeight: Math.round(height * 0.75),
              }
        }
      >
        {visible.length === 0 && (
          <p className={styles.heatEmpty}>
            {ASSET_CLASS_LABEL[selected]} 종목 데이터가 아직 없습니다
          </p>
        )}
        {sectorRects.map(({ item: g, left, top, width: gw, height: gh }) => {
          const bodyW = (gw / 100) * CANVAS_W;
          const bodyH = Math.max(1, (gh / 100) * height - SECTOR_LABEL_H);
          const rects = squarify(
            g.tiles.map((t) => ({ item: t, value: t.cap })),
            bodyW / bodyH,
          );
          return (
            <div
              key={g.sector}
              className={styles.heatGroup}
              style={{ left: `${left}%`, top: `${top}%`, width: `${gw}%`, height: `${gh}%` }}
            >
              <span className={styles.heatGroupLabel}>
                {g.sector} <span aria-hidden="true">›</span>
              </span>
              <div className={styles.heatGroupBody}>
                {rects.map(({ item: tile, left: tl, top: tt, width: tw, height: th }) => {
                  const pxArea = ((tw / 100) * bodyW) * ((th / 100) * bodyH);
                  const cls = sizeClass(pxArea);
                  const r = tile.row;
                  const label =
                    `${tile.name} — 시가총액 약 ${tile.cap >= 1 ? Math.round(tile.cap) : tile.cap}조 원, ` +
                    (r ? `활성 예측 ${r.total}건, 상승 ${r.up} 하락 ${r.down}` : "활성 예측 없음");
                  return (
                    <Link
                      key={tile.ticker}
                      href={`/leaderboard?asset=${selected}`}
                      className={`${styles.heatTile} ${cls}`}
                      style={{
                        left: `${tl}%`,
                        top: `${tt}%`,
                        width: `${tw}%`,
                        height: `${th}%`,
                        ...tileStyle(r),
                      }}
                      aria-label={label}
                      title={label}
                    >
                      {cls === styles.heatTileXl && (
                        <span className={styles.heatLogo} aria-hidden="true">
                          <StockLogo code={tile.ticker} name={tile.name} size={34} />
                        </span>
                      )}
                      <span className={styles.heatName}>{tile.name}</span>
                      {r && (
                        <span className={styles.heatDirs}>
                          {consensusLabel(r)}
                          {cls === styles.heatTileXl && ` · ${r.total}건`}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
