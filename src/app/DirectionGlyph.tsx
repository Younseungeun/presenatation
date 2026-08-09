import { PROFITABILITY_LABEL, type ProfitabilityLevel } from "@/domain/profitability";

// 방향 미니 그래프 — "▲ 상승" 같은 화살표+문구를 대신하는 작은 궤적 글리프.
//
// 방향은 **모양(기울기)이 전담한다** — 색각 이상·흑백에서도 방향이 남는 이유이고,
// 카드 배경 궤적과 같은 원칙이다. 색(pos/neg)은 보조 신호일 뿐이다.
//
// 수익성은 **면 채움의 진하기 5단계**로 싣는다. v3 점수에 기여하지 않아 확신 종합
// 별점(starSummary)에서 빠진 값인데, 색상을 새로 쓰면 방향색과 섞이고 숫자를 붙이면
// 얇은 행이 무거워진다. "무게(진하기)로 읽는" 문법은 순위 메달·등급 칩과 같은
// 브랜드 논리라 배우지 않아도 통한다. 정확한 구간은 카드 상세의 별점이 말한다.
//
// 이 글리프도 궤적이다 — 종목이 가려진 화면(구매 전 목록)에서만 쓴다는 규칙을
// 그대로 따른다 (MaskedCard 상단 주석 참조).

/** 수익성 1~5 → 면 채움 % (없으면 채우지 않는다) */
const FILL_PCT: Record<ProfitabilityLevel, number> = {
  1: 12,
  2: 20,
  3: 30,
  4: 41,
  5: 54,
};

/** 상승 꼴 꺾은선 — 되돌림 한 번을 넣어 "그래프"로 읽히게 한다 (직선 사선은 화살표로 보인다) */
const UP_POINTS: ReadonlyArray<readonly [number, number]> = [
  [1, 10.5],
  [8, 5.8],
  [11.5, 7.8],
  [19, 1.5],
];

function linePath(up: boolean): string {
  const pts = UP_POINTS.map(([x, y]) => [x, up ? y : 12 - y] as const);
  return `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")}`;
}

function areaPath(up: boolean): string {
  return `${linePath(up)} V11.5 H1 Z`;
}

export function DirectionGlyph({
  direction,
  profitability,
  size = 18,
}: {
  direction: string | null;
  profitability: ProfitabilityLevel | null;
  size?: number;
}) {
  const up = direction !== "DOWN";
  const tone = up ? "var(--pos)" : "var(--neg)";
  const label = `${up ? "상승" : "하락"} 예측${
    profitability ? ` · 수익성 ${PROFITABILITY_LABEL[profitability]}` : ""
  }`;
  return (
    <svg
      width={size}
      height={Math.round((size * 12) / 20)}
      viewBox="0 0 20 12"
      role="img"
      aria-label={label}
    >
      {profitability && (
        <path
          d={areaPath(up)}
          fill={`color-mix(in srgb, ${tone} ${FILL_PCT[profitability]}%, transparent)`}
        />
      )}
      <path
        d={linePath(up)}
        fill="none"
        stroke={tone}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
