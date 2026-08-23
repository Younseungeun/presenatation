import { INVESTMENT_DISCLAIMER } from "@/domain/legalDocs";

// 리포트·예측 카드 하단 투자 유의 문구. 문구는 legalDocs.ts의 자리표시자 —
// 변호사 확정 문구가 오면 그 상수만 교체하면 전 화면에 반영된다.
export function Disclaimer({ className }: { className?: string }) {
  return (
    <p
      className={className}
      style={{
        fontSize: 11.5,
        lineHeight: 1.6,
        color: "var(--text-faint)",
        marginTop: 20,
        paddingTop: 12,
        borderTop: "1px solid var(--border)",
      }}
    >
      {INVESTMENT_DISCLAIMER}
    </p>
  );
}
