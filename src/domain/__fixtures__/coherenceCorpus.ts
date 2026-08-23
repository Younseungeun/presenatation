// 문서 단위 평가 코퍼스 — 본문 결론과 예측 카드의 정합성(CARD_MISMATCH).
//
// 왜 문장 코퍼스와 파일을 나눴는가:
// 섞으면 표본 수와 오탐률 분모가 바뀌어 **기존 기준선과의 변경 전후 비교가 깨진다.**
// 문장 기준선(screeningCorpus)은 정규식·임베딩의 잣대로 그대로 두고, 여기는 그 자로는
// 원리적으로 못 재는 능력만 따로 잰다.
//
// 왜 이 코퍼스가 필요한가:
// 판정과 정산은 전적으로 **카드**로 이루어지는데 구매자는 **본문**을 읽고 산다.
// 둘이 어긋나면 구매자는 자기가 읽은 것과 다른 근거로 돈을 잃는다. 그런데 이 어긋남은
// 문장의 성질이 아니라 문서와 카드를 맞대본 결과라, "문장 → 소견" 자로는 잴 수 없다.
//
// 무엇이 어려운가 (이 코퍼스 설계의 전부):
// **정상 리포트는 원래 반대 시나리오를 길게 쓴다.** 상승을 전망하면서 하방 리스크를
// 세 문단 다루는 것은 좋은 리포트의 조건이지 모순이 아니다. 어휘를 세는 방식으로
// 접근하면 성실하게 쓴 리포트일수록 더 걸린다 — 규칙 단계에서 겪은 부정문 오탐과
// 정확히 같은 함정이다. 그래서 `risk_heavy`(리스크를 길게 다루지만 결론은 카드와 같은
// 방향)를 정상 문항의 과반으로 채웠다. 이 항목들이 오탐 없이 통과하는지가
// 이 코퍼스의 유일한 합격 조건에 가깝다.
//
// 한계: 손으로 만든 부트스트랩이다. 절대 수치가 아니라 변경 전후 비교에만 쓴다.
// 운영자 판정이 쌓이면 그쪽이 진짜 검증셋이 되고 이건 회귀 테스트용으로 남는다.
//
// ⚠ **운영자 판정을 이 형식으로 자동 변환할 때 막히는 곳이 하나 있다** (2026-08-19 확인).
// 세 축 중 둘은 그대로 온다 — 본문(Report.content)과 카드(PredictionCard),
// 그리고 라벨(operatorVerdict + operatorCategories → violation).
// **`kind`가 오지 않는다.** ComplianceReview 스키마에 그 칸이 없고, 있을 수도 없다 —
// kind는 "이 건이 왜 어려운가"에 대한 판단이지 운영자가 큐에서 내리는 결정이 아니다.
//
// 그런데 kind가 이 코퍼스의 값어치 전부다. 합쳐서 세면 "방향은 잡는데 기간은 전혀 못 본다"가
// 숨고, `risk_heavy` 오탐률이라는 채택선 자체가 성립하지 않는다.
// 즉 **자동 변환은 "라벨은 있으나 층이 없는" 데이터를 만든다** — 총합 정확도는 잴 수 있지만
// 모델 채택 판단에는 그대로 쓸 수 없다.
//
// 선택지는 셋이고 전부 대가가 있다:
//  ⓐ 운영자가 반려할 때 kind를 함께 고른다 — 정확하지만 큐 처리에 손이 하나 더 든다
//  ⓑ 승인/반려만 자동 수집하고 kind는 나중에 사람이 붙인다 — 미룬 것이지 푼 것이 아니다
//  ⓒ 운영 데이터는 **총합 지표 전용**으로 쓰고 층별 판단은 이 손코퍼스로 계속 한다
//     — 그러면 이 34건이 영구 자산이 되므로 지금보다 훨씬 키워야 한다
// 정하기 전에 운영 데이터 몇 건이 쌓이는지부터 봐야 한다 (현재 0건).

import type { CorpusItem } from './screeningCorpus';

// ── 위반: 본문 결론과 카드 방향이 반대 ────────────────────────────────
//
// 가장 명백하고 가장 해로운 형태. 본문을 읽고 산 구매자와 카드로 매겨지는 판정이
// 정반대를 가리킨다.

const DIRECTION_FLIP: CorpusItem[] = [
  {
    title: '밸류에이션 부담 구간 진입',
    summary: '현 주가는 과열 구간으로 판단하며 비중 축소를 권고합니다.',
    text: '최근 3개월 주가는 62% 상승해 12개월 선행 PER이 28배까지 올라왔습니다. 동종업계 평균 16배 대비 뚜렷한 프리미엄이며, 이를 정당화할 만한 실적 상향은 확인되지 않았습니다. 기관 순매도가 5주 연속 이어지고 있고 대차잔고도 증가 추세입니다. 결론적으로 현 구간에서는 신규 진입보다 차익 실현이 합리적이라고 판단합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'direction_flip',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 18, horizonDays: 60 },
  },
  {
    title: '업황 저점 통과 신호',
    summary: '재고 조정이 마무리 국면에 접어들었습니다.',
    text: '유통 재고가 정점 대비 34% 감소하며 정상 수준에 근접했습니다. 주요 고객사의 발주 재개가 확인되었고, 판가도 2개 분기 만에 반등했습니다. 업황 사이클상 저점을 지난 것으로 판단하며 실적 회복은 다음 분기부터 가시화될 전망입니다. 중장기 관점에서 매수 접근이 유효하다고 봅니다.',
    violation: 'CARD_MISMATCH',
    kind: 'direction_flip',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 15, horizonDays: 90 },
  },
  {
    title: '수급 악화 지속',
    summary: '오버행 부담이 해소되기 전까지 하방 압력이 이어질 것으로 봅니다.',
    text: '재무적 투자자의 보호예수가 다음 달 해제되며 유통 물량이 현재의 1.4배로 늘어납니다. 과거 유사 사례에서 해제 전후 3주간 평균 11% 조정이 있었습니다. 실적 자체는 견조하지만 수급이 이를 압도하는 국면으로 판단합니다. 오버행 소화 이전에는 보수적 접근을 권합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'direction_flip',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 22, horizonDays: 45 },
  },
  {
    title: '실적 서프라이즈와 재평가 국면',
    summary: '컨센서스를 크게 상회한 실적으로 눈높이 상향이 예상됩니다.',
    text: '3분기 영업이익은 컨센서스를 41% 상회했습니다. 일회성 요인을 제외해도 26% 초과 달성이며, 마진 개선이 구조적이라는 점이 확인되었습니다. 증권사 목표주가 상향이 이어지고 있고 외국인 순매수도 재개됐습니다. 재평가가 진행 중인 구간으로 판단합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'direction_flip',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 12, horizonDays: 30 },
  },
  {
    title: '경쟁 심화로 점유율 하락 전망',
    summary: '신규 진입자의 공격적 가격 정책이 마진을 잠식하고 있습니다.',
    text: '중국 업체 두 곳이 동일 스펙 제품을 30% 낮은 가격에 출시했습니다. 이미 주요 고객사 한 곳에서 물량 일부를 내준 것으로 파악됩니다. 판가 방어를 위한 마케팅 비용 증가가 불가피해 영업이익률은 전년 대비 4%p 하락할 것으로 추정합니다. 실적 하향 조정이 뒤따를 것으로 봅니다.',
    violation: 'CARD_MISMATCH',
    kind: 'direction_flip',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 25, horizonDays: 60 },
  },
  {
    title: '규제 리스크 현실화',
    summary: '주력 사업에 대한 규제 도입이 확정 단계에 들어갔습니다.',
    text: '해당 사업부 매출의 절반가량이 규제 대상에 포함될 것으로 보입니다. 시행령 초안 기준으로 연간 영업이익 1,200억원 규모의 감소가 예상됩니다. 회사는 대응책을 준비 중이라고 밝혔으나 구체적인 내용은 공개되지 않았습니다. 불확실성이 해소되기 전까지는 하방 위험이 크다고 판단합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'direction_flip',
    card: { direction: 'UP', targetType: 'TARGET_PRICE', targetLabel: '98,000원', horizonDays: 90 },
  },
  {
    title: '차익 실현 권고',
    summary: '목표가에 도달해 투자의견을 하향합니다.',
    text: '기존 제시한 목표주가 14만원에 지난주 도달했습니다. 실적 개선은 대부분 주가에 반영된 것으로 판단하며, 추가 상향 여지는 제한적입니다. 여기서부터는 기대수익 대비 감내해야 할 변동성이 커집니다. 보유 물량의 단계적 축소를 권고합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'direction_flip',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 20, horizonDays: 60 },
  },
  {
    title: '환율 수혜 지속',
    summary: '고환율 국면이 수출 마진을 밀어올리고 있습니다.',
    text: '매출의 78%가 달러 결제이고 원가의 상당 부분은 원화로 지출됩니다. 환율이 10원 오를 때마다 연간 영업이익이 약 180억원 증가하는 구조입니다. 현 환율 수준이 유지된다면 내년 실적 컨센서스는 상향될 여지가 큽니다. 긍정적인 시각을 유지합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'direction_flip',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 14, horizonDays: 45 },
  },
];

// ── 위반: 본문 목표 수준과 카드 숫자가 뚜렷이 다름 ────────────────────
//
// 방향은 맞다. 그래서 방향만 보는 탐지기는 전부 놓친다.
// 본문에서 "10% 내외"를 말하고 카드에 45%를 거는 것은, 본문을 읽고 산 구매자가
// 자기가 산 것보다 네 배 공격적인 주장에 돈을 건 셈이 된다.

const MAGNITUDE_GAP: CorpusItem[] = [
  {
    title: '완만한 회복 국면',
    summary: '10% 내외의 제한적인 상승 여력을 봅니다.',
    text: '수요 회복은 확인되지만 속도는 완만합니다. 현재 밸류에이션이 역사적 중간값 수준이라 재평가 폭은 크지 않을 것으로 봅니다. 보수적으로 10% 내외의 상승 여력을 제시합니다. 급격한 반등을 기대하기보다 실적 확인을 따라가는 접근을 권합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'magnitude_gap',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 45, horizonDays: 90 },
  },
  {
    title: '목표주가 8만원 제시',
    summary: '현재가 대비 소폭의 상승 여력이 있습니다.',
    text: '내년 예상 주당순이익에 업종 평균 배수를 적용해 목표주가 8만원을 제시합니다. 현재가 7만 5천원 대비 약 7%의 상승 여력입니다. 실적 가시성은 높으나 이미 상당 부분 주가에 반영되어 있습니다. 안정적인 배당 매력을 함께 고려한 판단입니다.',
    violation: 'CARD_MISMATCH',
    kind: 'magnitude_gap',
    card: { direction: 'UP', targetType: 'TARGET_PRICE', targetLabel: '128,000원', horizonDays: 90 },
  },
  {
    title: '기술적 반등 시도',
    summary: '단기 낙폭 과대에 따른 5% 수준의 반등을 예상합니다.',
    text: '20일 이동평균선 대비 이격도가 88까지 벌어졌습니다. 과거 이 수준에서는 평균 5% 내외의 기술적 반등이 있었습니다. 다만 추세 전환으로 보기에는 거래량이 부족합니다. 제한적인 반등 이상을 기대하기는 어렵다고 판단합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'magnitude_gap',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 30, horizonDays: 60 },
  },
  {
    title: '구조적 성장의 초입',
    summary: '중장기 주가는 현재의 두 배 수준까지 열려 있다고 봅니다.',
    text: '전방 시장이 향후 3년간 연평균 40% 성장할 것으로 전망됩니다. 이 회사는 해당 시장에서 두 번째로 큰 점유율을 확보하고 있고 증설도 마무리 단계입니다. 성장이 계획대로 반영된다면 현재 주가의 두 배 수준까지 열려 있다고 판단합니다. 다만 실행 리스크는 감안해야 합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'magnitude_gap',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 4, horizonDays: 90 },
  },
  {
    title: '보수적 관점의 하락 전망',
    summary: '3~5% 수준의 완만한 조정을 예상합니다.',
    text: '단기 과열 지표가 나타나고 있으나 펀더멘털 훼손은 없습니다. 계절적 비수기 진입에 따른 3~5% 수준의 완만한 조정을 예상합니다. 큰 폭의 하락을 전망하는 것은 아니며 조정 시 재진입 기회로 봅니다. 실적 자체에 대한 시각은 그대로 유지합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'magnitude_gap',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 28, horizonDays: 60 },
  },
];

// ── 위반: 본문 시간축과 카드 검증 시한이 어긋남 ───────────────────────
//
// 방향도 크기도 맞는데 시간이 어긋난 경우. 가장 눈에 안 띄고, 그래서 가장 오래 남는다.
// "3거래일 내 반등"을 말하고 검증 시한을 180일로 잡으면, 본문의 주장이 틀려도
// 카드는 반년 동안 살아 있다 — 주장과 판정이 사실상 분리된다.

const HORIZON_GAP: CorpusItem[] = [
  {
    title: '단기 반등 임박',
    summary: '3거래일 내 기술적 반등을 예상합니다.',
    text: '연속 5일 하락으로 단기 과매도 구간에 진입했습니다. 장중 저가 매수세가 유입되며 아래 꼬리가 길어지고 있습니다. 3거래일 안에 기술적 반등이 나올 가능성이 높다고 봅니다. 반등 이후에는 다시 관망을 권합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'horizon_gap',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 8, horizonDays: 180 },
  },
  {
    title: '2~3년에 걸친 구조적 전환',
    summary: '사업 구조 전환의 성과는 중장기에 걸쳐 나타날 것입니다.',
    text: '주력 사업을 하드웨어에서 구독 모델로 전환하는 작업이 시작됐습니다. 이런 전환은 통상 2~3년에 걸쳐 매출 구성이 바뀌며 초기에는 오히려 실적이 눌립니다. 전환이 완료되면 이익의 질과 배수가 모두 개선될 것으로 봅니다. 긴 호흡의 접근이 필요한 종목입니다.',
    violation: 'CARD_MISMATCH',
    kind: 'horizon_gap',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 12, horizonDays: 7 },
  },
  {
    title: '이번 주 실적 발표가 분수령',
    summary: '금주 실적 발표 결과에 따라 방향이 결정됩니다.',
    text: '목요일 장 마감 후 3분기 실적이 발표됩니다. 컨센서스 부합 여부보다 내년 가이던스 제시가 관건입니다. 발표 직후 주가 반응이 이후 흐름을 좌우할 것으로 봅니다. 결과 확인 전까지는 포지션을 크게 가져갈 이유가 없습니다.',
    violation: 'CARD_MISMATCH',
    kind: 'horizon_gap',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 15, horizonDays: 365 },
  },
  {
    title: '중장기 배당 매력',
    summary: '수년에 걸친 배당 확대 정책이 자리잡고 있습니다.',
    text: '회사는 향후 5년간 배당성향을 단계적으로 50%까지 올리겠다고 밝혔습니다. 현금흐름이 안정적이고 대규모 투자 계획도 마무리됐습니다. 배당 재평가는 여러 해에 걸쳐 서서히 진행되는 성격입니다. 단기 시세 차익보다 장기 보유 관점에서 접근할 종목입니다.',
    violation: 'CARD_MISMATCH',
    kind: 'horizon_gap',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 9, horizonDays: 5 },
  },
];

// ── 정상: 본문과 카드가 일치 ──────────────────────────────────────────

const COHERENT: CorpusItem[] = [
  {
    title: '반도체 업황 회복 진입',
    summary: '메모리 가격 반등으로 실적 개선이 예상됩니다.',
    text: 'DRAM 고정거래가격이 2개월 연속 상승했습니다. 감산 효과가 나타나며 재고가 정상 수준으로 내려왔습니다. 내년 상반기까지 가격 상승 흐름이 이어질 것으로 보며 실적 추정치를 상향합니다. 목표주가도 함께 올립니다.',
    violation: null,
    kind: 'coherent',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 20, horizonDays: 90 },
  },
  {
    title: '수주 잔고 사상 최대',
    summary: '2조원을 넘은 수주 잔고가 3년치 일감을 확보했습니다.',
    text: '이번 분기 신규 수주는 공시 기준 8,400억원입니다. 누적 잔고는 2조원을 넘어 연간 매출의 3배 수준입니다. 수익성이 좋은 고부가 선종 비중이 높아진 점도 긍정적입니다. 실적 가시성이 크게 개선됐다고 판단합니다.',
    violation: null,
    kind: 'coherent',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 16, horizonDays: 60 },
  },
  {
    title: '원가 부담 확대',
    summary: '주요 원재료 가격 급등으로 마진 훼손이 불가피합니다.',
    text: '핵심 원재료 가격이 6개월 만에 두 배가 됐습니다. 판가 전가는 계약 구조상 6개월 이상 시차가 발생합니다. 그 사이 영업이익률은 현재의 절반 수준까지 떨어질 것으로 추정합니다. 실적 하향이 주가에 반영될 것으로 봅니다.',
    violation: null,
    kind: 'coherent',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 18, horizonDays: 60 },
  },
  {
    title: '목표주가 12만원으로 상향',
    summary: '실적 추정치 상향을 반영해 목표주가를 올립니다.',
    text: '내년 주당순이익 추정치를 8,200원으로 12% 상향합니다. 여기에 업종 평균을 소폭 웃도는 배수를 적용해 목표주가 12만원을 제시합니다. 현재가 10만 3천원 대비 약 17%의 상승 여력입니다. 투자의견 매수를 유지합니다.',
    violation: null,
    kind: 'coherent',
    card: { direction: 'UP', targetType: 'TARGET_PRICE', targetLabel: '120,000원', horizonDays: 90 },
  },
  {
    title: '점유율 회복 확인',
    summary: '신제품 출시 이후 점유율이 3개 분기 만에 반등했습니다.',
    text: '국내 점유율이 전분기 대비 2.4%p 상승했습니다. 신제품 반응이 좋고 유통망 확대도 계획대로 진행 중입니다. 마케팅 비용이 늘었지만 매출 증가가 이를 상쇄하는 구조입니다. 개선 흐름이 이어질 것으로 봅니다.',
    violation: null,
    kind: 'coherent',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 14, horizonDays: 45 },
  },
  {
    title: '단기 조정 예상',
    summary: '계절적 비수기 진입으로 단기 조정이 나올 것으로 봅니다.',
    text: '4분기는 전통적으로 출하가 줄어드는 시기입니다. 최근 주가 상승분에 이 부분이 충분히 반영되지 않았다고 판단합니다. 단기적으로 10% 안팎의 조정 가능성을 봅니다. 조정 이후에는 다시 접근할 만하다고 생각합니다.',
    violation: null,
    kind: 'coherent',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 10, horizonDays: 30 },
  },
  {
    title: '증설 완료와 가동률 상승',
    summary: '신규 라인 가동으로 생산능력이 40% 늘어납니다.',
    text: '2년간 진행한 증설이 다음 달 완료됩니다. 이미 확보한 수주만으로도 초기 가동률 80% 이상이 가능합니다. 고정비 부담이 분산되며 마진 개선 효과가 나타날 것으로 봅니다. 내년 실적 성장의 핵심 동력입니다.',
    violation: null,
    kind: 'coherent',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 22, horizonDays: 120 },
  },
];

// ── 정상: 리스크를 길게 다루지만 결론은 카드와 같은 방향 ──────────────
//
// **이 코퍼스에서 가장 중요한 묶음이다.**
//
// 반대 시나리오를 충실히 서술하는 것은 좋은 리포트의 조건이다. 여기가 걸리기 시작하면
// 성실하게 쓴 리서처일수록 더 막히고, 그 사람들은 대개 돌아오지 않는다.
// 규칙 단계에서 면책 문구가 즉시 거절되던 것과 정확히 같은 실패다 — 층만 올라왔다.
//
// 임베딩은 특히 여기서 무너진다. "하락 위험이 크다"와 "하락 위험은 제한적이다"의
// 벡터가 가깝기 때문이다. 부정에 약하다는 1단계의 원리적 한계가 문서 단위에서
// 다시 나타나는 지점이라, 이 묶음의 오탐률이 곧 모델 채택의 판정선이 된다.

const RISK_HEAVY: CorpusItem[] = [
  {
    title: '리스크를 감안해도 매력적인 구간',
    summary: '하방 위험을 충분히 반영해도 상승 여력이 남아 있다고 봅니다.',
    text: '먼저 위험 요인을 짚습니다. 전방 수요가 예상보다 부진할 경우 실적 추정치는 20% 이상 하향될 수 있습니다. 경쟁사의 증설도 2년 뒤 공급 과잉으로 이어질 소지가 있습니다. 환율이 하락 전환하면 수출 마진도 축소됩니다. 다만 이 시나리오들을 모두 반영해도 현재 주가는 청산가치 대비 할인 거래되고 있습니다. 하방이 제한된 구간이라고 판단해 매수 의견을 유지합니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 18, horizonDays: 90 },
  },
  {
    title: '세 가지 우려와 그럼에도 유효한 논리',
    summary: '제기되는 우려를 하나씩 검토했으나 투자 논리는 유지됩니다.',
    text: '시장이 제기하는 우려는 세 가지입니다. 첫째 고객사 집중도가 높다는 점, 둘째 신규 진입자의 가격 공세, 셋째 핵심 인력 이탈입니다. 각각 실질적인 위험이며 특히 첫 번째는 매출의 62%가 한 곳에 몰려 있어 가볍게 볼 수 없습니다. 그러나 해당 고객사와의 계약이 5년 단위로 갱신되었고 신규 고객 두 곳이 추가됐습니다. 우려는 유효하되 이미 주가에 과도하게 반영됐다고 판단합니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 25, horizonDays: 120 },
  },
  {
    title: '반등 논리에 대한 반론 검토',
    summary: '반등을 기대하는 시각을 검토했으나 하락 전망을 유지합니다.',
    text: '시장 일각에서는 낙폭 과대에 따른 반등을 기대합니다. 밸류에이션이 역사적 저점 수준이고 자사주 매입도 발표됐다는 점이 근거입니다. 이 논리 자체는 타당합니다. 다만 저평가는 이익 추정치가 더 내려가면 언제든 해소됩니다. 현재 컨센서스는 여전히 낙관적이며 추가 하향 여지가 크다고 봅니다. 반등을 논하기에는 이릅니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 16, horizonDays: 60 },
  },
  {
    title: '상승 여력과 변동성을 함께 봅니다',
    summary: '변동성이 큰 종목이나 기대수익이 이를 상회합니다.',
    text: '이 종목은 일간 변동성이 코스피 평균의 2.5배입니다. 단기간에 20% 이상 움직이는 일이 드물지 않고 실제로 지난 분기에도 그런 구간이 있었습니다. 투자 시 원금 손실 가능성이 있으며 변동성을 감내할 수 있는 경우에만 접근해야 합니다. 그럼에도 신사업의 가치가 현 시가총액에 거의 반영되지 않았다고 판단해 상승 전망을 제시합니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 30, horizonDays: 90 },
  },
  {
    title: '하락 요인이 우세한 국면',
    summary: '긍정적 요소가 있으나 하방 압력이 더 크다고 봅니다.',
    text: '긍정적인 부분부터 언급하면, 신제품 반응이 좋고 해외 매출 비중도 늘고 있습니다. 재무구조 역시 업종 내에서 양호한 편입니다. 그러나 주력 제품의 판가가 3개 분기 연속 하락 중이고 이를 만회할 물량 증가는 확인되지 않습니다. 고정비 비중이 높은 구조라 판가 하락은 이익에 증폭되어 반영됩니다. 긍정 요인이 이를 상쇄하기는 어렵다고 판단합니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 20, horizonDays: 90 },
  },
  {
    title: '실패 시나리오를 먼저 적습니다',
    summary: '이 판단이 틀릴 수 있는 조건을 명시합니다.',
    text: '이 전망이 틀리는 경우는 명확합니다. 임상 결과가 기대에 못 미치거나 승인이 지연되면 주가는 반토막 이하로 떨어질 수 있습니다. 바이오 섹터 특성상 그런 일은 실제로 자주 일어납니다. 투자 결과에 대한 책임은 투자자 본인에게 있으며 이 리포트는 참고 자료입니다. 그 위험을 전제로, 확률과 기대값 측면에서는 여전히 매수가 유리하다고 봅니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 40, horizonDays: 180 },
  },
  {
    title: '조정 국면이나 추세는 훼손되지 않았습니다',
    summary: '단기 조정을 예상하지만 이는 상승 추세 내의 되돌림입니다.',
    text: '최근 급등으로 단기 지표가 과열권에 들어섰고 차익 매물도 나오고 있습니다. 향후 몇 주간은 조정이 나올 가능성이 높습니다. 그러나 이는 상승 추세 안에서의 되돌림으로 보며 추세 자체가 꺾였다고 판단하지 않습니다. 실적 개선의 방향성은 그대로이고 목표 기간 내 상승 전망을 유지합니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 24, horizonDays: 120 },
  },
  {
    title: '거시 불확실성 아래의 판단',
    summary: '거시 변수의 불확실성이 크나 종목 자체의 논리는 유효합니다.',
    text: '금리 경로와 환율 모두 예측이 어려운 국면입니다. 금리가 예상보다 오래 높게 유지되면 성장주 전반의 배수가 눌리고 이 종목도 예외가 아닙니다. 시장 상황에 따라 전망이 빗나갈 수 있으며 이 경우 손실이 발생합니다. 다만 이 회사의 현금창출력은 금리 국면과 무관하게 개선되고 있고, 그 부분이 아직 주가에 반영되지 않았습니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 15, horizonDays: 90 },
  },
  {
    title: '악재는 이미 알려졌습니다',
    summary: '알려진 악재보다 알려지지 않은 개선 요인에 주목합니다.',
    text: '소송 리스크, 규제 강화, 주요 임원 사임까지 부정적인 소식이 연이어 나왔습니다. 각각 실적에 영향을 줄 수 있는 사안이며 소송의 경우 최대 3천억원 규모입니다. 이런 악재들은 이미 6개월에 걸쳐 주가에 반영됐습니다. 반면 자회사 상장 가치는 시장이 거의 반영하지 않고 있어, 여기서부터의 위험 대비 보상은 유리하다고 봅니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 28, horizonDays: 150 },
  },
  {
    title: '반등 기대를 접어야 하는 이유',
    summary: '저평가 매력에도 불구하고 추가 하락을 전망합니다.',
    text: '자산가치 대비 할인율이 역사적 최대 수준까지 벌어졌습니다. 배당수익률도 6%를 넘어 표면적으로는 매력적입니다. 이 점만 보면 매수 논리를 세울 수 있습니다. 그러나 본업의 현금흐름이 3년 연속 감소했고 배당의 지속 가능성 자체가 의심받는 상황입니다. 할인에는 이유가 있으며 그 이유가 해소되는 신호는 아직 없습니다.',
    violation: null,
    kind: 'risk_heavy',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 22, horizonDays: 120 },
  },
];

// ── 위반: 리스크를 길게 쓰고도 결론이 카드와 반대 ─────────────────────
//
// **표에서 비어 있던 칸이다** (2026-08-19 외부 검토가 흐릿하게 가리킨 자리를 세어보고 발견).
//
//            리스크 서술 짧음   리스크 서술 김
//   정합      coherent 7건      risk_heavy 10건
//   모순      위반 17건         ← 0건이었다
//
// 왜 위험한가: `risk_heavy`를 봐주도록 배운 탐지기는 **리스크 문단을 길게 깔면
// 카드를 뒤집어도 통과시킨다.** 어뷰저가 해야 할 일이 "하방 위험을 성실히 쓰는 시늉"뿐이
// 되는 것이다. 하드 네거티브만 넣고 이 칸을 비워두면 그 구멍이 지표에 잡히지 않는다.
//
// 종류를 `direction_flip`과 나눠 세는 이유도 같다 — 합쳐 세면
// "평범한 모순은 잡는데 위장한 모순은 통째로 놓친다"가 숨는다.

const FLIP_UNDER_RISK: CorpusItem[] = [
  {
    title: '리스크를 감안한 신중한 판단',
    summary: '여러 위험 요인을 검토한 결과 보수적 접근이 필요합니다.',
    text: '먼저 하방 위험부터 짚습니다. 전방 수요 둔화가 예상보다 길어지고 있고, 경쟁사 증설이 내년 상반기 마무리되면 공급 과잉이 현실화됩니다. 원재료 가격도 우호적이지 않습니다. 반대로 긍정적 요인을 찾자면 재무구조가 견조하다는 점 정도입니다. 이 요인들을 모두 저울에 올린 결과, 당분간은 비중을 줄이고 지켜보는 것이 합리적이라고 판단합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'flip_under_risk',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 20, horizonDays: 90 },
  },
  {
    title: '위험 요인을 충분히 검토했습니다',
    summary: '리스크를 상세히 다룬 뒤 투자의견을 제시합니다.',
    text: '이 종목은 변동성이 코스피 평균의 두 배이며 원금 손실 가능성이 있습니다. 주력 사업의 규제 리스크가 남아 있고 고객사 집중도도 높습니다. 시장 상황에 따라 전망이 빗나갈 수 있으며 이 경우 손실이 발생합니다. 이런 위험들을 모두 반영하면 현 주가는 이미 적정 가치를 웃돌고 있다고 봅니다. 목표주가를 하향하고 투자의견도 함께 낮춥니다.',
    violation: 'CARD_MISMATCH',
    kind: 'flip_under_risk',
    card: { direction: 'UP', targetType: 'TARGET_PRICE', targetLabel: '145,000원', horizonDays: 120 },
  },
  {
    title: '하락 논리를 점검했습니다',
    summary: '약세 시각을 검토했으나 근거가 충분하지 않습니다.',
    text: '시장의 우려는 세 가지입니다. 재고 증가, 판가 하락, 그리고 환율입니다. 각각 실적에 영향을 줄 수 있는 사안이고 특히 재고는 2개 분기 연속 늘었습니다. 그러나 재고 증가는 신제품 출시를 앞둔 선제 생산이고, 판가는 이미 저점을 지났으며, 환율은 오히려 수출 마진에 유리합니다. 우려는 대부분 해소 국면이며 실적 개선이 다음 분기부터 확인될 것으로 봅니다.',
    violation: 'CARD_MISMATCH',
    kind: 'flip_under_risk',
    card: { direction: 'DOWN', targetType: 'RETURN_PCT', magnitudePct: 18, horizonDays: 90 },
  },
  {
    title: '보수적으로 접근할 구간',
    summary: '기대와 위험을 함께 검토했습니다.',
    text: '이 리포트는 투자 참고 자료이며 투자 결과에 대한 책임은 투자자 본인에게 있습니다. 신사업의 성장성은 분명하지만 상용화까지 최소 2년이 걸리고 그 사이 자금 소요가 큽니다. 증자 가능성도 배제할 수 없어 주주가치 희석 위험이 있습니다. 성장 스토리에 비해 현 주가가 앞서 나가 있다고 판단하며, 조정을 기다렸다 접근하는 편이 낫다고 봅니다.',
    violation: 'CARD_MISMATCH',
    kind: 'flip_under_risk',
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 35, horizonDays: 180 },
  },
];

// ── 관측 전용: 크기 구간 경계 ─────────────────────────────────────────
//
// 크기 판정을 수익성 5구간에 걸었지만(claudeScreener), 그것은 경계를 **옮겼을 뿐
// 없앤 것이 아니다.** 주식 기준 경계는 7.5 / 10 / 15 / 25%이고, 14%와 16%는 여전히
// 다른 구간이다. 그 2%p 차이를 사람이 "본문과 카드가 어긋난다"로 볼지는 **답이 없다.**
//
// 그래서 채점하지 않는다. 모르는 채로 라벨을 붙이면 그 임의의 판단이 그대로 채택선이 되고,
// 손코퍼스의 1인 라벨 문제만 키운다. 탐지기가 여기서 **뭐라고 하는지만 관측**하고,
// 교사 실측과 운영자 판정이 쌓이면 그때 `probe`를 떼고 정식 라벨을 붙인다.
//
// 마지막 항목은 반대 방향 관측이다 — 규칙상으로는 같은 구간이라 통과인데,
// 3%p 차이를 사람은 어떻게 볼 것인가.

const MAGNITUDE_PROBE: CorpusItem[] = [
  {
    title: '완만한 상승 여력',
    summary: '14% 내외의 상승 여력을 봅니다.',
    text: '실적 개선 폭을 반영하면 14% 내외의 상승 여력이 있다고 판단합니다. 급격한 재평가를 기대하기보다 실적 확인을 따라가는 접근을 권합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'magnitude_gap',
    probe: true, // 3구간(10~15) vs 4구간(15~25) — 경계 15%를 2%p 사이에 두고 갈린다
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 16, horizonDays: 90 },
  },
  {
    title: '제한적 반등 예상',
    summary: '9% 수준의 반등을 예상합니다.',
    text: '낙폭 과대에 따른 9% 수준의 반등을 예상합니다. 추세 전환으로 보기에는 거래량이 부족합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'magnitude_gap',
    probe: true, // 2구간(7.5~10) vs 3구간(10~15) — 2%p 차이
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 11, horizonDays: 60 },
  },
  {
    title: '공격적 목표 제시',
    summary: '24% 수준의 상승을 목표로 합니다.',
    text: '증설 효과가 온전히 반영되면 24% 수준의 상승이 가능하다고 봅니다. 실행 리스크는 감안해야 합니다.',
    violation: 'CARD_MISMATCH',
    kind: 'magnitude_gap',
    probe: true, // 4구간(15~25) vs 5구간(25~) — 3%p 차이
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 27, horizonDays: 120 },
  },
  {
    title: '적극적 매수 구간',
    summary: '11% 상승 여력을 제시합니다.',
    text: '밸류에이션 매력과 실적 모멘텀을 함께 고려해 11%의 상승 여력을 제시합니다.',
    violation: null,
    kind: 'coherent',
    probe: true, // 둘 다 3구간이라 규칙은 통과 — 그런데 3%p 차이를 사람은 어떻게 볼까
    card: { direction: 'UP', targetType: 'RETURN_PCT', magnitudePct: 14, horizonDays: 90 },
  },
];

export const COHERENCE_CORPUS: CorpusItem[] = [
  ...DIRECTION_FLIP,
  ...MAGNITUDE_GAP,
  ...HORIZON_GAP,
  ...FLIP_UNDER_RISK,
  ...COHERENT,
  ...RISK_HEAVY,
  ...MAGNITUDE_PROBE,
];
