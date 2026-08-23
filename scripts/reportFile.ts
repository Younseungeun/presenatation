import { ASSET_CLASSES, type AssetClass } from '../src/domain/constants';
import type { ScreeningInput } from '../src/domain/compliance';

// **사람이 손으로 쓰는 리포트 형식** — 파싱은 여기 한 곳에만 있다.
//
// `tryScreening`(검수 결과 보기)과 `addTrainingCase`(학습 자료로 넣기)가 같은 파일을
// 읽는다. 둘이 각자 파싱하면 언젠가 해석이 갈라지고, 그러면 **화면에서 본 결과와
// 학습에 들어간 내용이 다른** 상태가 된다 — 이 저장소가 buildStudentText 를 한 곳에만
// 두는 것과 같은 이유다.
//
// 형식(--- 위는 카드, 아래는 본문):
//
//   제목: 삼성전자 4분기 전망
//   요약: 메모리 업황 개선을 예상합니다
//   자산군: 국내주식
//   종목: 삼성전자
//   방향: 상승
//   목표: 12%
//   기간: 90일
//   신뢰도: 5
//   ---
//   여기부터 본문입니다.

const ASSET_ALIAS: Record<string, AssetClass> = {
  국내주식: 'KR_EQUITY',
  미국주식: 'US_EQUITY',
  해외주식: 'US_EQUITY',
  코인: 'CRYPTO',
  암호화폐: 'CRYPTO',
};

export function parseReportFile(raw: string): ScreeningInput {
  const [headRaw, ...rest] = raw.split(/^---\s*$/m);
  const body = rest.join('---').trim();
  const head = new Map<string, string>();
  for (const line of headRaw.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：]+)\s*[:：]\s*(.*)$/);
    if (m) head.set(m[1].trim(), m[2].trim());
  }
  // 헤더가 없으면 파일 전체를 본문으로 본다 — 문장 하나만 던져 보고 싶을 때가 많다
  const content = body || (head.size === 0 ? raw.trim() : '');

  const num = (k: string): number | null => {
    const v = head.get(k);
    if (!v) return null;
    const n = Number(v.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  const assetRaw = head.get('자산군') ?? '국내주식';
  const assetClass =
    ASSET_ALIAS[assetRaw] ??
    ((ASSET_CLASSES as readonly string[]).includes(assetRaw)
      ? (assetRaw as AssetClass)
      : 'KR_EQUITY');

  const dir = head.get('방향') ?? '상승';
  const magnitudePct = num('목표');

  return {
    title: head.get('제목') ?? '',
    summary: head.get('요약') ?? '',
    content,
    assetClass,
    assetName: head.get('종목') ?? '',
    direction: /하락|내림|DOWN|sell|매도/i.test(dir) ? 'DOWN' : 'UP',
    targetType: magnitudePct == null ? undefined : 'RETURN_PCT',
    magnitudePct,
    horizonDays: num('기간'),
    confidence: num('신뢰도'),
  };
}

/** 읽은 내용을 사람에게 되읽어 준다 — 오타로 카드가 비어도 알아챌 수 있게 */
export function describeInput(input: ScreeningInput): string {
  return [
    `  제목    ${input.title || '(없음)'}`,
    `  요약    ${input.summary || '(없음)'}`,
    `  카드    ${input.assetName || '(종목 없음)'} · ${input.direction === 'UP' ? '상승' : '하락'}` +
      `${input.magnitudePct != null ? ` ${input.magnitudePct}%` : ''}` +
      `${input.horizonDays != null ? ` · ${input.horizonDays}일` : ''}` +
      `${input.confidence != null ? ` · 신뢰도 ${input.confidence}` : ''}`,
    `  본문    ${input.content.length}자`,
  ].join('\n');
}
