import { InstitutionalBadge } from "./InstitutionalBadge";
import { VerifiedBadge } from "./VerifiedBadge";

// 경력 배지 — 어떤 로제트를 달지 한곳에서 정한다.
//
// 브랜드에는 배지가 두 벌 있다 (README §4-3):
//   · badge-verified      Mint 700 — 인증 애널리스트
//   · badge-institutional Deep Ink — 기관 출신
// 같은 로제트 기하에 색만 다르고, 흰 체크는 양쪽 공통이다.
//
// 매핑: 전직 증권사 애널리스트(ANALYST)만 "기관 출신"이다 — 소속 기관이 검증의 근거인
// 유일한 경우라서. CFA·회계사·산업 전문가는 자격·경력이 근거이므로 인증 배지를 쓴다.

export function CareerBadge({ careerBadge, size = 14 }: { careerBadge: string | null; size?: number }) {
  if (!careerBadge) return null;
  return careerBadge === "ANALYST" ? (
    <InstitutionalBadge size={size} />
  ) : (
    <VerifiedBadge size={size} />
  );
}
