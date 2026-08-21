import Link from "next/link";
import {
  RISK_CATEGORY_LABEL,
  SCREENING_LAYERS,
  type Finding,
  type RiskCategory,
  type ScreeningLayer,
} from "@/domain/compliance";
import a from "./admin.module.css";

// **소견 하나를 그리는 유일한 자리** (인계 2호 §4 · 2026-08-21).
//
// ── 왜 출처를 갈라 보여주는가 ──────────────────────────────────
// 오탐일 때 **고치는 곳이 다르다.** 이것이 이 표시의 존재 이유 전부다:
//
//   [규칙 · 코드]   → 개발자가 배포해야 고쳐진다. 운영자는 지금 할 수 있는 게 없다
//   [규칙 · 사전]   → **운영자가 그 자리에서 끈다.** 클릭 한 번
//   [학생]          → 라벨을 쌓아 재학습해야 고쳐진다. 오늘은 안 고쳐진다
//
// 셋을 뭉쳐 그리면 운영자는 매번 "이건 내가 고칠 수 있나"를 되물어야 하고,
// 되묻는 비용이 크면 결국 아무것도 안 고친다.
//
// ── 즉시 거절 권한은 코드 원천뿐이다 ───────────────────────────
// 사전 항목도 학생도 아무리 확신해도 WARN까지다. 화면이 그 비대칭을 흐리면
// 운영자가 "사전에 넣으면 막을 수 있다"고 오해한다 (인계 2호 §5).

/** 사전이 규칙 엔진의 입력이 된 뒤로 `learned` 도 층을 달고 온다 (회신 Q5) */
function layerLabel(layer: ScreeningLayer | undefined): string | null {
  return layer ? (SCREENING_LAYERS[layer] ?? null) : null;
}

/**
 * **음성 변형은 근사 매칭이다** (회신 Q5 지시).
 *
 * 자모 편집거리 1로 잡은 것이라 다른 층보다 오탐 확률이 구조적으로 높다.
 * 운영자가 그 사실을 **모른 채** 보면 정확 매칭과 같은 무게로 읽는다.
 */
const APPROXIMATE_LAYERS = new Set<ScreeningLayer>(["L5_PHONETIC"]);

function SourceChip({ f }: { f: Finding }) {
  const layer = layerLabel(f.layer);
  const approx = f.layer ? APPROXIMATE_LAYERS.has(f.layer) : false;

  if (f.source === "student") {
    // 확신은 **필드에서** 읽는다 — reason 문자열을 파싱하면 문구가 바뀔 때 조용히 깨진다.
    // 옛 기록에는 값이 없으므로(선택 필드) 없으면 숫자를 생략한다
    const pct = typeof f.confidence === "number" ? ` · 확신 ${Math.round(f.confidence * 100)}%` : "";
    return <span className={a.chip}>학생{pct}</span>;
  }

  if (f.source === "learned") {
    return (
      <>
        {/* 사전 항목으로 곧장 간다 — 운영자가 **지금 끌 수 있는** 유일한 출처라
            링크가 곧 처방이다. phraseId 가 없는 옛 기록은 글자만 남긴다 */}
        {f.phraseId ? (
          <Link
            href={`/admin/compliance?tab=phrases#p-${f.phraseId}`}
            className={a.chip}
          >
            규칙 · 사전{layer ? ` · ${layer}` : ""} →
          </Link>
        ) : (
          <span className={a.chip}>규칙 · 사전{layer ? ` · ${layer}` : ""}</span>
        )}
        {approx && <span className={`${a.chip} ${a.chipWarn}`}>근사 매칭</span>}
      </>
    );
  }

  // 'rule' — 그리고 옛 기록의 'ai'·'semantic'·출처 없음.
  // 없는 것을 '코드'라고 단정하지 않는다: 출처 필드가 생기기 전 기록이 실제로 있다
  if (f.source === "rule") {
    return (
      <>
        <span className={a.chip}>규칙 · 코드{layer ? ` · ${layer}` : ""}</span>
        {approx && <span className={`${a.chip} ${a.chipWarn}`}>근사 매칭</span>}
      </>
    );
  }
  return <span className={a.chip}>{f.source ?? "출처 미기록"}</span>;
}

export function FindingRow({ f }: { f: Finding }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div className={a.lbl} style={{ marginBottom: 6 }}>
        <span className={`${a.chip} ${f.severity === "BLOCK" ? a.chipNeg : a.chipWarn}`}>
          {f.severity === "BLOCK" ? "위반" : "확인 필요"}
        </span>
        {RISK_CATEGORY_LABEL[f.category as RiskCategory]}
        <small>{f.reason}</small>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
        <SourceChip f={f} />
      </div>

      {/* 인용은 잘라 온 한 줄이라 그것만으로는 판단할 수 없다 —
          같은 문장도 앞에 "권유가 아닙니다"가 붙어 있으면 다른 글이다.
          **빈 따옴표를 그리지 않는다**: 학생은 문서 전체를 보고 판정해 문장을 못 짚는데,
          `""` 를 내보내면 운영자에게 고장으로 읽힌다 */}
      {f.quote ? (
        <div className={a.quote}>&ldquo;{f.quote}&rdquo;</div>
      ) : (
        <div className={a.hint}>본문 전체 — 특정 문장을 짚지 못합니다</div>
      )}
    </div>
  );
}
