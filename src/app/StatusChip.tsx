import styles from "./statusChip.module.css";

// 검증 상태의 시각 언어 — 앱 전체에서 단 하나의 어휘를 쓴다.
//  · 판정 결과(적중/실패/판정 불가) = "도장": 결과 글리프 + 옅은 틴트 배경. 끝난 일.
//  · 검증 중 = "진행형": 민트 + 맥동하는 점. 아직 시장이 채점하는 중이라는 뜻.
//  · 판매 중·초안·종료·철회 = 중립 회색. 판정과 무관한 관리 상태.
// 화면마다 제각각이던 배지(맨 텍스트·pill·인라인 색)를 전부 이 칩으로 갈아끼운다.

export type StatusKind =
  | "HIT"
  | "MISS"
  | "UNDECIDABLE"
  | "VERIFYING"
  | "SELLING"
  | "DRAFT"
  | "PENDING_REVIEW"
  | "ENDED"
  | "WITHDRAWN";

const META: Record<
  StatusKind,
  { label: string; tone: "pos" | "neg" | "warn" | "live" | "neutral"; glyph?: string }
> = {
  HIT: { label: "적중", tone: "pos", glyph: "✓" },
  MISS: { label: "실패", tone: "neg", glyph: "✕" },
  UNDECIDABLE: { label: "판정 불가", tone: "warn", glyph: "!" },
  VERIFYING: { label: "검증 중", tone: "live" },
  SELLING: { label: "판매 중", tone: "neutral" },
  DRAFT: { label: "초안", tone: "neutral" },
  // 컴플라이언스 검수 보류 — 아직 판매 전이고 사람의 결정을 기다린다.
  // warn 톤: 실패는 아니지만 리서처가 손을 놓고 있으면 안 되는 상태다
  PENDING_REVIEW: { label: "검토 중", tone: "warn" },
  ENDED: { label: "종료", tone: "neutral" },
  WITHDRAWN: { label: "철회", tone: "neutral" },
};

/** Judgment.outcome 문자열 → 칩 상태 (알 수 없는 값은 판정 불가로 취급) */
export function outcomeStatus(outcome: string): StatusKind {
  return outcome === "HIT" ? "HIT" : outcome === "MISS" ? "MISS" : "UNDECIDABLE";
}

export function StatusChip({
  status,
  label,
}: {
  status: StatusKind;
  /** 기본 라벨 대신 쓸 문구 (예: "판정 대기 · 에스크로 보관 중") */
  label?: string;
}) {
  const m = META[status];
  return (
    <span className={`${styles.chip} ${styles[m.tone]}`}>
      {m.tone === "live" && <span className={styles.dot} aria-hidden />}
      {m.glyph && (
        <span className={styles.glyph} aria-hidden>
          {m.glyph}
        </span>
      )}
      {label ?? m.label}
    </span>
  );
}
