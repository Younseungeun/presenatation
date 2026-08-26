import Link from "next/link";
import { RISK_CATEGORY_LABEL, type Finding, type RiskCategory } from "@/domain/compliance";
import a from "../admin.module.css";
import s from "./flaggedReport.module.css";

// **검수가 문제 삼은 워딩을 본문 안에서 그대로 보여준다** (2026-08-26 창업자 지시).
//
// ── 왜 합쳤나 ──────────────────────────────────────────────────────
// 예전에는 두 개가 따로 있었다: ① "이용자가 보게 될 화면 열기" 링크(본문은 다른 화면)
// ② 소견 목록(인용문만 잘라 보여줌). 운영자는 인용 한 줄을 보고 "이게 본문 어디쯤,
// 어떤 맥락에 있나"를 알려면 링크를 눌러 다른 화면에서 눈으로 찾아야 했다.
// 같은 문장도 앞에 "권유가 아닙니다"가 붙어 있으면 다른 글인데, 잘린 인용은 그걸 못 보여준다.
//
// 그래서 **본문을 그 자리에 펼치고, 문제 삼은 부분만 빨갛게 칠한다.** 맥락과 지적이
// 한 화면에서 만난다.
//
// ── 마스킹은 여기서 문제되지 않는다 ────────────────────────────────
// 구매 전 마스킹은 **구매자**를 위한 것이고, 이 화면은 운영자 전용이다. 운영자는 원래
// 전부 본다. 다만 카드의 종목·목표가·별점은 본문에 없어 여기 없다 — 그건 전체 화면
// 링크가 채운다(하나로 합치되, 텍스트에 없는 것까지 지어내지 않는다).

/** 한 조각 — 평문이거나, 소견이 붙은 빨간 조각이거나 */
interface Segment {
  text: string;
  finding: Finding | null;
}

/**
 * 인용문을 매칭 가능한 형태로 정리한다.
 *
 * `quoteAround`(domain/compliance)가 인용문을 만들 때 두 가지를 한다:
 *   ① 잘린 쪽에 `…`(U+2026)를 붙인다 — 맥락 표시용
 *   ② 공백·줄바꿈을 **단일 스페이스로 압축**한다 — 한 줄로 읽기 쉽게
 * 그래서 원문에 `indexOf` 로 그대로 넣으면 **절대 안 찾아진다.** `…`를 벗기고,
 * 매칭도 같은 공백 정규화 위에서 해야 한다.
 */
export function cleanQuote(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/^…+/, "")
    .replace(/…+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 공백을 단일 스페이스로 압축한 사본 + **원문 좌표로 되돌리는 지도**.
 *
 * 인용문은 공백이 압축돼 있으므로 원문에 그대로는 못 찾는다. 압축본끼리 맞춘 뒤
 * 지도로 원문 위치를 복원해야, **원문을 그대로 그리면서** 맞은 구간만 칠할 수 있다.
 */
function buildNorm(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let i = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      norm += " ";
      map.push(i); // 압축된 공백 한 칸은 원문 공백 런의 첫 글자를 가리킨다
      while (i < text.length && /\s/.test(text[i])) i++;
    } else {
      norm += text[i];
      map.push(i);
      i++;
    }
  }
  return { norm, map };
}

/** 소견들이 이 텍스트에서 차지하는 구간 — **원문 좌표로.** 못 찾으면 그 소견은 빠진다 */
function matchSpans(
  text: string,
  findings: Finding[],
): { start: number; end: number; finding: Finding }[] {
  const { norm, map } = buildNorm(text);
  const spans: { start: number; end: number; finding: Finding }[] = [];
  for (const f of findings) {
    const q = cleanQuote(f.quote);
    if (!q) continue;
    let from = 0;
    for (;;) {
      const at = norm.indexOf(q, from);
      if (at < 0) break;
      const start = map[at];
      const lastNorm = at + q.length - 1;
      const end = lastNorm < map.length ? map[lastNorm] + 1 : text.length;
      spans.push({ start, end, finding: f });
      from = at + q.length;
    }
  }
  return spans;
}

/** 이 소견이 이 텍스트들 중 어딘가에서 실제로 위치를 잡히는가 (아래 '못 짚은 소견' 판정용) */
export function isLocated(fields: string[], f: Finding): boolean {
  const q = cleanQuote(f.quote);
  if (!q) return false;
  return fields.some((t) => buildNorm(t).norm.includes(q));
}

/**
 * 텍스트를 소견 인용문 기준으로 조각낸다.
 *
 * · 인용문은 실제로는 `quoteAround` 가 만든 **맥락 창**(±15자)이라, 이웃한 두 소견의
 *   창이 자주 겹친다. 겹칠 때 **하나를 버리면 그 소견의 워딩이 통째로 안 칠해진다**
 *   (실측: "빚투" 소견이 앞 소견과 겹쳐 사라졌다). 그래서 겹치면 **합쳐서** 그 구간을
 *   통째로 칠한다 — 문제 삼은 워딩이 빠지지 않는 것이 우선이다.
 * · 합친 구간의 색·툴팁은 **가장 무거운 소견**(BLOCK 우선)을 대표로 쓴다.
 * · 같은 인용문이 본문에 여러 번 나오면 **모두** 칠한다. 문제는 그 표현 자체다.
 * · 인용문이 본문에서 안 찾아지면(IRIS 전체 판정·카드 소견) 조각을 만들지 않는다 —
 *   그 소견은 아래 "문장을 짚지 못한 소견"으로 따로 뜬다.
 */
export function segmentText(text: string, findings: Finding[]): Segment[] {
  if (!text) return [];
  const spans = matchSpans(text, findings);
  if (spans.length === 0) return [{ text, finding: null }];

  spans.sort((x, y) => x.start - y.start || y.end - x.end);

  // 겹치거나 맞닿은 구간을 하나로 합친다 — 대표 소견은 더 무거운 쪽(BLOCK)
  const merged: { start: number; end: number; finding: Finding }[] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp.start <= last.end) {
      last.end = Math.max(last.end, sp.end);
      if (sp.finding.severity === "BLOCK" && last.finding.severity !== "BLOCK") {
        last.finding = sp.finding;
      }
    } else {
      merged.push({ ...sp });
    }
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (const m of merged) {
    if (m.start > cursor) segments.push({ text: text.slice(cursor, m.start), finding: null });
    segments.push({ text: text.slice(m.start, m.end), finding: m.finding });
    cursor = m.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), finding: null });
  return segments;
}

/** 소견 하나가 어느 층에서 왔는지 — 툴팁 한 줄로. FindingRow 의 칩과 같은 말 */
function sourceLabel(f: Finding): string {
  if (f.source === "student") return "IRIS";
  if (f.source === "learned") return "규칙·사전";
  if (f.source === "rule") return "규칙·코드";
  return f.source ?? "출처 미기록";
}

/** 심각도 — 규칙 BLOCK 만 즉시 거절, 나머지는 확인 필요(WARN) */
function severityWord(f: Finding): string {
  return f.severity === "BLOCK" ? "위반" : "확인 필요";
}

/** 텍스트를 소견 인용문 기준으로 조각내 빨간 <mark> 로 그린다 (라벨 없음) */
function Highlighted({ text, findings }: { text: string; findings: Finding[] }) {
  const segs = segmentText(text, findings);
  return (
    <>
      {segs.map((seg, i) =>
        seg.finding ? (
          <mark
            key={i}
            className={seg.finding.severity === "BLOCK" ? s.markBlock : s.mark}
            title={`${severityWord(seg.finding)} · ${RISK_CATEGORY_LABEL[seg.finding.category as RiskCategory] ?? seg.finding.category} · ${sourceLabel(seg.finding)}`}
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

/**
 * 검수 카드 — **제목 + 위반 이유 칩 + 빨간 본문**, 박스 전체가 이용자 화면으로 가는 문.
 * (2026-08-26 창업자 시안: 요약·별도 링크 박스 삭제, 박스 클릭 = 이용자 화면 이동)
 *
 * ── 위반 이유는 칩으로 (우상단) ────────────────────────────────────
 * 소견 유형을 칩으로 모아 우상단에 둔다. 본문에서 위치를 잡은 소견은 아래에서 빨갛게도
 * 칠해지지만, IRIS 전체 판정·카드 소견처럼 **문장을 못 짚는 것**은 빨간 자리가 없어
 * 칩만이 유일한 표시다 — 그래서 유형은 위치 여부와 무관하게 전부 칩으로 나온다.
 * 감추면 "빨간 데가 없으니 문제없다"는 오독이 생긴다.
 *
 * ── 종목·목표가·별점은 본문에 없다 ─────────────────────────────────
 * 그것들은 카드에 있어 인라인으로 못 채운다. 박스를 누르면 그 전체 화면으로 가므로,
 * 하나로 합치되 텍스트에 없는 정보를 지어내지 않는다.
 */
export function FlaggedReport({
  reportId,
  title,
  content,
  findings,
  pendingPublish,
}: {
  reportId: string;
  title: string;
  /** @deprecated 시안에서 요약은 표시하지 않는다 — 시그니처 호환용으로만 남긴다 */
  summary?: string | null;
  content: string | null;
  findings: Finding[];
  /** 게시 전이면 아직 아무도 못 본 화면, 게시 후면 이미 팔리는 화면 (접근성 라벨의 시제) */
  pendingPublish: boolean;
}) {
  // 위반 이유 칩 — 유형별로 하나씩, 더 무거운 심각도(BLOCK)를 대표로. 툴팁에 근거·출처
  const byCategory = new Map<string, Finding>();
  for (const f of findings) {
    const prev = byCategory.get(f.category);
    if (!prev || (f.severity === "BLOCK" && prev.severity !== "BLOCK")) {
      byCategory.set(f.category, f);
    }
  }
  const reasonChips = [...byCategory.values()];

  const viewLabel = pendingPublish
    ? "이용자가 보게 될 전체 화면 열기 (종목·목표가·별점까지)"
    : "이용자가 보는 전체 화면 열기 (종목·목표가·별점까지)";

  return (
    // **박스 전체가 링크다** — 누르면 이용자 화면으로 (시안). mark 의 툴팁은 hover 라
    // 클릭과 겹치지 않는다
    <Link href={`/report/${reportId}`} className={s.card} aria-label={viewLabel} title={viewLabel}>
      <div className={s.top}>
        <span className={s.title}>
          <Highlighted text={title} findings={findings} />
        </span>
        {reasonChips.length > 0 && (
          <span className={s.chips}>
            {reasonChips.map((f, i) => (
              <span
                key={i}
                className={`${a.chip} ${f.severity === "BLOCK" ? a.chipNeg : a.chipWarn}`}
                title={`${severityWord(f)} · ${sourceLabel(f)}${f.reason ? ` · ${f.reason}` : ""}`}
              >
                {RISK_CATEGORY_LABEL[f.category as RiskCategory] ?? f.category}
              </span>
            ))}
          </span>
        )}
      </div>

      {content?.trim() ? (
        <p className={s.body}>
          <Highlighted text={content} findings={findings} />
        </p>
      ) : (
        <p className={`${s.body} ${s.empty}`}>본문이 없습니다</p>
      )}
    </Link>
  );
}
