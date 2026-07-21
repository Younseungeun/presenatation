// 약관·법적 고지 문서 (버전 관리).
//
// ⚠️ 본문(body)은 전부 자리표시자(placeholder)다. 변호사 검토·작성 산출물이 오면
// body를 교체하고 version·effectiveDate를 갱신한다. 동의 이력(Consent)은 이 version을
// 기준으로 기록되므로, 문구가 실질적으로 바뀌면 반드시 version을 올려 재동의를 받게 한다.
//
// draft=true인 동안에는 화면에 "검토 전 초안" 배지를 노출해, 확정 문서로 오인되지 않게 한다.

export const LEGAL_DOC_KEYS = [
  'TERMS_OF_SERVICE',
  'PRIVACY_POLICY',
  'RESEARCHER_AGREEMENT',
] as const;
export type LegalDocKey = (typeof LEGAL_DOC_KEYS)[number];

export interface LegalDoc {
  key: LegalDocKey;
  title: string;
  /** 동의 이력 기준 버전. 문구가 실질적으로 바뀌면 올린다 */
  version: string;
  effectiveDate: string;
  /** 변호사 확정 전 자리표시자 여부 */
  draft: boolean;
  /** 동의 화면용 한 줄 요약 */
  summary: string;
  /** 전문 (섹션 배열 — 자리표시자) */
  sections: Array<{ heading: string; text: string }>;
}

const DRAFT_NOTE =
  '※ 본 문서는 변호사 검토 전 초안입니다. 확정 문구로 교체 예정이며, 실제 계약 효력은 확정본을 따릅니다.';

export const LEGAL_DOCS: Record<LegalDocKey, LegalDoc> = {
  TERMS_OF_SERVICE: {
    key: 'TERMS_OF_SERVICE',
    title: '이용약관',
    version: '2026-07-16-draft',
    effectiveDate: '서비스 공개일',
    draft: true,
    summary: '리포트 구매·열람, 예측 자동 판정, 환불 규정에 관한 이용 조건입니다.',
    sections: [
      {
        heading: '제1조 (목적)',
        text: '본 약관은 회사가 제공하는 리서치 마켓플레이스 서비스의 이용 조건과 절차, 회사와 이용자의 권리·의무를 정합니다. ' + DRAFT_NOTE,
      },
      {
        heading: '제2조 (서비스의 성격)',
        text: '본 서비스는 독립 리서처가 공개 자료를 기반으로 작성한 분석 리포트를 판매하는 콘텐츠 거래 플랫폼입니다. 리포트는 투자 판단의 참고 자료이며, 회사와 리서처는 이용자의 투자 결과에 대해 책임지지 않습니다. 본 서비스는 1:1 개별 투자자문을 제공하지 않습니다.',
      },
      {
        heading: '제3조 (예측 카드와 자동 판정)',
        text: '모든 유료 리포트에는 종목·방향·목표 크기·검증 시한으로 구성된 예측 카드가 포함됩니다. 검증 시한이 도래하면 지정된 거래소 시세 데이터를 기준으로 적중/실패가 자동 판정되며, 판정 기준(거래소·기준가·시각)은 서비스가 사전에 정한 규칙을 따릅니다. 게시된 예측 카드는 수정·삭제할 수 없습니다.',
      },
      {
        heading: '제4조 (결제와 환불)',
        text: '구매 대금은 결제대금예치(에스크로)로 보관되며, 예측 판정 결과에 따라 정산됩니다. 예측이 적중하지 못한 경우 회사는 구매자에게 콘텐츠 거래대금을 환불합니다. 이때 환불 대상은 이용자의 투자 손실이 아니라 리포트 콘텐츠의 거래대금이며, 회사는 이용자의 투자 손실을 보전하지 않습니다. 거래정지·상장폐지 등으로 판정이 불가능한 경우 전액을 환불합니다. 환불은 전액 현금(결제 취소 또는 계좌이체)으로 지급하며, 별도의 포인트·적립금·선불수단을 발행하지 않습니다. ' + DRAFT_NOTE,
      },
      {
        heading: '제5조 (열람과 청약철회)',
        text: '디지털 콘텐츠의 특성상 리포트 본문을 열람한 이후에는 단순 변심에 의한 청약철회가 제한될 수 있으며, 회사는 구매 전에 이를 고지합니다. 구체적 범위는 관련 법령과 확정 약관에 따릅니다. ' + DRAFT_NOTE,
      },
      {
        heading: '제6조 (금지 행위)',
        text: '이용자는 미공개 중요정보·부정 취득 정보·풍문 유포성 콘텐츠의 게시, 타인 명의 도용, 결제·평판 조작 등을 하여서는 안 됩니다.',
      },
    ],
  },
  PRIVACY_POLICY: {
    key: 'PRIVACY_POLICY',
    title: '개인정보처리방침',
    version: '2026-07-16-draft',
    effectiveDate: '서비스 공개일',
    draft: true,
    summary: '본인확인 정보의 수집·이용·보관에 관한 방침입니다.',
    sections: [
      {
        heading: '수집하는 개인정보',
        text: '회사는 1인 1계정 확인을 위해 휴대폰 본인확인을 거치며, 본인확인기관으로부터 연계정보(CI)를 전달받습니다. CI 원문은 저장하지 않고, 서버 비밀키로 해시한 값만 보관해 동일인 여부 판단에만 사용합니다. 그 밖에 필명, 결제·정산 정보를 수집합니다. ' + DRAFT_NOTE,
      },
      {
        heading: '이용 목적',
        text: '본인확인(계정 중복·명의 세탁 방지), 결제·정산·환불 처리, 판정 결과 알림, 법령상 의무 이행을 위해 이용합니다.',
      },
      {
        heading: '보관 기간',
        text: '관련 법령이 정한 기간 동안 보관 후 파기합니다. 전자상거래 등에서의 소비자보호에 관한 법률 등에 따른 보존 의무를 따릅니다. ' + DRAFT_NOTE,
      },
      {
        heading: '이용자의 권리',
        text: '이용자는 자신의 개인정보 열람·정정·삭제·처리정지를 요청할 수 있습니다.',
      },
    ],
  },
  RESEARCHER_AGREEMENT: {
    key: 'RESEARCHER_AGREEMENT',
    title: '리서처 이용계약',
    version: '2026-07-16-draft',
    effectiveDate: '서비스 공개일',
    draft: true,
    summary: '리포트 판매·정산·수수료·성과 연동에 관한 판매자 계약입니다.',
    sections: [
      {
        heading: '제1조 (지위)',
        text: '리서처는 본 플랫폼을 통해 자신이 작성한 분석 리포트를 판매하는 판매자입니다. 리서처는 공개 자료에 기반한 분석만을 게시하며, 미공개 중요정보나 1:1 개별 자문을 제공하지 않습니다. ' + DRAFT_NOTE,
      },
      {
        heading: '제2조 (유사투자자문업 신고 등 법령 준수)',
        text: '리서처는 관련 법령이 요구하는 신고·등록 의무를 스스로 확인하고 이행할 책임이 있습니다. 신고 주체와 범위는 확정 계약에서 정합니다. 회사는 신고 여부 표시·확인 등 필요한 관리 조치를 취할 수 있습니다. ' + DRAFT_NOTE,
      },
      {
        heading: '제3조 (예측 카드·게시 규칙)',
        text: '리서처가 게시한 예측 카드는 수정·삭제할 수 없으며, 철회는 기록에 남습니다. 리서처는 시세 공급자가 지원하는 종목만 선택할 수 있고, 하락 예측은 숏 실행 수단이 있는 종목으로 제한됩니다.',
      },
      {
        heading: '제4조 (수수료·정산·성과 연동)',
        text: '판매액에서 등급별 수수료를 공제한 금액이 정산됩니다. 예측이 적중하지 못한 경우 성과 연동분은 구매자에게 환불되며, 그 범위는 게시 시점의 선결제 비율에 따릅니다. 수수료율·선결제 비율은 게시 시점에 고정됩니다.',
      },
      {
        heading: '제5조 (등급·평판)',
        text: '판정 결과로 산정된 점수에 따라 등급이 오르내리며, 성과 기록은 프로필에 공개됩니다. 회사는 어뷰징 방지를 위한 게시 제한 규칙을 적용할 수 있습니다.',
      },
    ],
  },
};

/** 가입 시 필수 동의 문서 */
export const SIGNUP_REQUIRED_DOCS: LegalDocKey[] = ['TERMS_OF_SERVICE', 'PRIVACY_POLICY'];
/** 리서처 전환 시 필수 동의 문서 */
export const RESEARCHER_REQUIRED_DOCS: LegalDocKey[] = ['RESEARCHER_AGREEMENT'];

export function getLegalDoc(key: string): LegalDoc | null {
  return (LEGAL_DOCS as Record<string, LegalDoc>)[key] ?? null;
}

/** 구매 화면 환불 규정 요약 (전자상거래법 고지용 — 자리표시자) */
export const REFUND_POLICY_SUMMARY =
  '예측이 적중하지 못하면 콘텐츠 거래대금을 현금으로 환불합니다(환불 대상은 투자 손실이 아닌 콘텐츠 대금). 거래정지·상장폐지 등 판정 불가 시 전액 환불합니다. 본문 열람 후에는 단순 변심에 의한 청약철회가 제한될 수 있습니다.';

/** 리포트·예측 카드 하단 투자 유의 문구 (자리표시자 — 변호사 확정 문구로 교체) */
export const INVESTMENT_DISCLAIMER =
  '본 리포트는 공개 자료에 기반한 분석·전망이며 투자권유가 아닙니다. 예측의 자동 판정은 콘텐츠 검증을 위한 것으로, 투자 결과를 보장하지 않습니다. 투자 판단과 그 결과의 책임은 이용자 본인에게 있습니다.';
