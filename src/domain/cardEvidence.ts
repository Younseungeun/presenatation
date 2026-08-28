// 예측 카드를 **본문에 실을 한 줄**로 만든다 (2026-08-28 창업자 지시).
//
// 비현실적 예측·카드 불일치처럼 위반이 본문이 아니라 예측 카드에 있는 유형은, 근거 문장
// 짚기가 본문에서 문장을 못 찾는다. 그래서 카드 값(종목·방향·목표·시한)을 이 한 줄로 만들어
// 본문 뷰 위에 **다른 글꼴로** 실어 그것을 짚게 한다 (EvidencePicker cardText).
//
// 순수 함수 — 주어진 값만 포맷한다(현재 시각을 읽지 않는다).

export interface CardEvidenceFields {
  assetName: string;
  ticker: string;
  assetClassLabel?: string | null;
  direction: 'UP' | 'DOWN';
  /** 예측 크기(%) — 목표가형이면 기준가 대비 환산값 */
  magnitudePct?: number | null;
  targetPrice?: number | null;
  currency?: string | null;
  deadline?: Date | null;
}

function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())}`;
}

export function formatCardEvidence(card: CardEvidenceFields): string {
  const dir = card.direction === 'UP' ? '상승' : '하락';
  const size =
    card.magnitudePct != null
      ? `목표 ${dir} ${Math.abs(card.magnitudePct).toFixed(1)}%` +
        (card.targetPrice != null
          ? ` (${card.targetPrice.toLocaleString('ko-KR')}${card.currency ?? ''})`
          : '')
      : card.targetPrice != null
        ? `목표가 ${card.targetPrice.toLocaleString('ko-KR')}${card.currency ?? ''} (${dir})`
        : `방향 ${dir}`;
  const parts = [
    card.assetClassLabel ?? null,
    `${card.assetName}(${card.ticker})`,
    size,
    card.deadline ? `검증 시한 ${fmtDate(card.deadline)}` : null,
  ].filter((x): x is string => !!x);
  return `〔예측 카드〕 ${parts.join(' · ')}`;
}
