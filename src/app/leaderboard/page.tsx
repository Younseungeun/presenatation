import { computeCardScore, sumScores } from "@/domain/scoring";
import { computeTrackRecord, type JudgedPrediction } from "@/domain/trackRecord";
import { evaluateTier } from "@/domain/tiers";

// 리더보드 스텁: DB 연동 전까지 목데이터로 도메인 모듈 배선을 검증한다.
// 실제 구현에서는 Prisma로 Judgment를 집계해 동일한 함수에 넣는다.

interface MockResearcher {
  penName: string;
  hasCareerBadge: boolean;
  predictions: JudgedPrediction[];
}

function mockPredictions(hits: number, misses: number): JudgedPrediction[] {
  const list: JudgedPrediction[] = [];
  for (let i = 0; i < hits; i++) {
    list.push({
      outcome: "HIT",
      direction: "UP",
      basePrice: 100,
      settledPrice: 112,
      judgedAt: new Date("2026-05-01"),
    });
  }
  for (let i = 0; i < misses; i++) {
    list.push({
      outcome: "MISS",
      direction: "UP",
      basePrice: 100,
      settledPrice: 95,
      judgedAt: new Date("2026-05-01"),
    });
  }
  return list;
}

const MOCK_RESEARCHERS: MockResearcher[] = [
  { penName: "밸류헌터", hasCareerBadge: true, predictions: mockPredictions(32, 18) },
  { penName: "역발상연구소", hasCareerBadge: false, predictions: mockPredictions(17, 10) },
  { penName: "신입리서처K", hasCareerBadge: false, predictions: mockPredictions(3, 1) },
];

// 목데이터 카드 조건 (예측 크기 12%, 신뢰도 5로 가정)
const MOCK_CARD = { predictedMagnitudePct: 12, confidence: 5 } as const;

function mockTotalScore(predictions: JudgedPrediction[]): number {
  return sumScores(
    predictions.map((p) => {
      const realized =
        ((p.settledPrice! - p.basePrice) / p.basePrice) * 100;
      return computeCardScore({ direction: p.direction, ...MOCK_CARD }, realized);
    }),
  );
}

export default function LeaderboardPage() {
  const rows = MOCK_RESEARCHERS.map((r) => {
    const record = computeTrackRecord(r.predictions);
    const totalScore = mockTotalScore(r.predictions);
    const tier = evaluateTier(totalScore);
    return { ...r, record, tier, totalScore };
  }).sort((a, b) => b.totalScore - a.totalScore);

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px" }}>
      <h1>적중률 리더보드</h1>
      <p>예측 카드가 시장 데이터로 자동 판정되어 쌓인 트랙레코드입니다.</p>
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 24 }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid currentColor" }}>
            <th style={{ padding: 8 }}>리서처</th>
            <th style={{ padding: 8 }}>등급</th>
            <th style={{ padding: 8 }}>점수</th>
            <th style={{ padding: 8 }}>판정 건수</th>
            <th style={{ padding: 8 }}>적중률</th>
            <th style={{ padding: 8 }}>가상 수익률</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.penName} style={{ borderBottom: "1px solid #8883" }}>
              <td style={{ padding: 8 }}>
                {r.penName}
                {r.hasCareerBadge && " 🎖️"}
                {r.record.verifying && (
                  <small style={{ marginLeft: 6, opacity: 0.7 }}>검증 중</small>
                )}
              </td>
              <td style={{ padding: 8 }}>{r.tier}</td>
              <td style={{ padding: 8 }}>{Math.round(r.totalScore).toLocaleString()}</td>
              <td style={{ padding: 8 }}>{r.record.sampleSize}</td>
              <td style={{ padding: 8 }}>
                {r.record.hitRate === null ? "—" : `${(r.record.hitRate * 100).toFixed(1)}%`}
              </td>
              <td style={{ padding: 8 }}>
                {r.record.hypotheticalReturnPct === null
                  ? "—"
                  : `${r.record.hypotheticalReturnPct >= 0 ? "+" : ""}${r.record.hypotheticalReturnPct.toFixed(1)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
