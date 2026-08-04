"use client";

// StockLogo — 종목코드를 받아 회사 로고를 자동 표시한다 (stock-logo 스킬 레퍼런스 이식).
// 해석 체인: 도메인 오버라이드 → krx-map(KIND 상장사 홈페이지) 도메인 → 파비콘 서비스
// → 로드 실패(onError) 시 이니셜 폴백 타일.
// 로고 파일을 모으지 않는다 — 종목코드→도메인 매핑만 있으면 파비콘 서비스가 해결.
// krx-map.json 재생성: node .claude/skills/stock-logo/scripts/build-krx-map.mjs (분기 1회)

import { useState } from "react";
import krxMap from "../data/krx-map.json";

type KrxEntry = { name: string; market: string; domain: string | null };

const favicon = (domain: string) =>
  `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;

// 본사 도메인 파비콘이 저해상(<64px)인 종목의 고해상 오버라이드 — 회사 계열 도메인에서
// 128px을 확보한다 (전수 측정 2026-08-04: skhynix.com 16px → 뉴스룸 128px 등).
// 도메인보다 먼저 적용된다 (해석 체인 1단계).
const LOGO_URL_OVERRIDES: Record<string, string> = {
  "000660": favicon("news.skhynix.co.kr"), // SK하이닉스 뉴스룸 (본사 16px)
  "373220": favicon("lg.com"), // LG엔솔 — LG 공통 심볼 (본사 16px)
  AMD: favicon("ir.amd.com"), // 본사 16px
  AMZN: favicon("aboutamazon.com"), // 본사 48px
  NVDA: favicon("docs.nvidia.com"), // 본사 48px
};

// KIND에 홈페이지가 없거나(LG엔솔) KIND 밖인 종목(미국주식·코인)의 도메인 수동 등록
const DOMAIN_OVERRIDES: Record<string, string> = {
  // 국내주식 보완
  "373220": "lgensol.com",
  // 미국주식
  NVDA: "nvidia.com",
  AAPL: "apple.com",
  MSFT: "microsoft.com",
  GOOGL: "google.com",
  AMZN: "amazon.com",
  META: "meta.com",
  TSLA: "tesla.com",
  AMD: "amd.com",
  NFLX: "netflix.com",
  AVGO: "broadcom.com",
  // 코인 (업비트 마켓코드 기준)
  "KRW-BTC": "bitcoin.org",
  "KRW-ETH": "ethereum.org",
  "KRW-SOL": "solana.com",
};

export function resolveLogoUrl(code: string): string | null {
  if (LOGO_URL_OVERRIDES[code]) return LOGO_URL_OVERRIDES[code];
  const domain =
    DOMAIN_OVERRIDES[code] ?? (krxMap as Record<string, KrxEntry>)[code]?.domain;
  if (domain) return favicon(domain);
  return null; // 폴백 타일로
}

// 결정적 폴백 배색: 같은 종목은 항상 같은 민트 톤 (브랜드 Mint 50/100/200/300)
const TILE_BG = ["#EAFBF6", "#CFF5EA", "#9FEBD6", "#63DCBE"];
function tileColor(code: string): string {
  let h = 0;
  for (const ch of code) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_BG[h % TILE_BG.length];
}

export function StockLogo({
  code,
  name,
  size = 40,
}: {
  code: string;
  name?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const entry = (krxMap as Record<string, KrxEntry>)[code];
  const displayName = name ?? entry?.name ?? code;
  const url = resolveLogoUrl(code);

  const container: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    // 다크 모드에서도 흰 원판 유지 — 투명·검정 로고가 사라지는 문제를 차단
    background: "#FFFFFF",
    border: "0.5px solid rgba(12,30,26,.12)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    flex: "none",
  };

  if (!url || failed)
    return (
      <span
        style={{ ...container, background: tileColor(code) }}
        role="img"
        aria-label={displayName}
      >
        <span
          style={{
            fontSize: size * 0.42,
            fontWeight: 700,
            color: "#0B4F42",
            lineHeight: 1,
          }}
        >
          {displayName.charAt(0)}
        </span>
      </span>
    );

  return (
    <span style={container}>
      <img
        src={url}
        alt={`${displayName} 로고`}
        width={size * 0.7}
        height={size * 0.7}
        style={{ objectFit: "contain" }}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
