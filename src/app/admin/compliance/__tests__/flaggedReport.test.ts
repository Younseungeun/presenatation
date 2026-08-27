import { describe, it, expect } from "vitest";
import { segmentText, cleanQuote, isLocated, type FlaggedFinding } from "../FlaggedReport";

// 본문을 소견 인용문 기준으로 조각내는 순수 로직 — 화면은 이 조각을 색만 입혀 그린다.
const f = (quote: string, severity: "BLOCK" | "WARN" = "WARN"): FlaggedFinding => ({
  category: "PROFIT_GUARANTEE",
  label: "수익 보장·손실 보전 표현",
  severity,
  quote,
  note: "x",
});

describe("segmentText — 문제 삼은 워딩만 조각낸다", () => {
  it("인용문 자리를 소견 조각으로, 나머지는 평문으로 가른다", () => {
    const segs = segmentText("이 종목은 반드시 오릅니다 지금 사세요", [f("반드시 오릅니다")]);
    expect(segs).toEqual([
      { text: "이 종목은 ", finding: null },
      { text: "반드시 오릅니다", finding: expect.objectContaining({ quote: "반드시 오릅니다" }) },
      { text: " 지금 사세요", finding: null },
    ]);
  });

  it("같은 표현이 여러 번 나오면 **모두** 칠한다", () => {
    const segs = segmentText("보장 그리고 또 보장", [f("보장")]);
    const marked = segs.filter((s) => s.finding);
    expect(marked).toHaveLength(2);
  });

  it("겹치는 소견은 **합쳐서** 그 구간을 통째로 칠한다 — 워딩이 빠지지 않게", () => {
    const segs = segmentText("원금 보장 약속", [f("원금 보장"), f("보장 약속")]);
    // 두 창이 "보장"에서 겹치므로 하나로 합쳐 "원금 보장 약속" 전체가 칠해진다
    const marked = segs.filter((s) => s.finding).map((s) => s.text);
    expect(marked).toEqual(["원금 보장 약속"]);
  });

  it("겹친 구간의 대표 소견은 더 무거운 쪽(BLOCK)이다", () => {
    const segs = segmentText("원금 보장 약속", [f("원금 보장", "WARN"), f("보장 약속", "BLOCK")]);
    const mark = segs.find((s) => s.finding);
    expect(mark?.finding?.severity).toBe("BLOCK");
  });

  it("인용문이 본문에 없으면 통째로 평문이다 — 조각내지 않는다", () => {
    const segs = segmentText("평범한 분석입니다", [f("있지도 않은 문장")]);
    expect(segs).toEqual([{ text: "평범한 분석입니다", finding: null }]);
  });

  it("빈 인용문(IRIS 전체 판정)은 무시한다 — 칠할 자리가 없다", () => {
    const segs = segmentText("본문", [f("")]);
    expect(segs).toEqual([{ text: "본문", finding: null }]);
  });

  it("빈 본문은 빈 배열", () => {
    expect(segmentText("", [f("보장")])).toEqual([]);
  });

  // ── quoteAround 가 만든 실제 인용문 형태(… 감싸기 + 공백 압축)를 맞춘다 ──
  it("앞뒤 … 로 감싼 인용문도 원문에서 찾아 칠한다", () => {
    // quoteAround 는 매칭 구간 ±15자를 자르고 잘린 쪽에 … 를 붙인다
    const body = "업계에서는 지금 빚투로라도 들어가야 한다는 이야기가 돕니다";
    const segs = segmentText(body, [f("…지금 빚투로라도 들어가야 한다는…")]);
    const marked = segs.filter((s) => s.finding).map((s) => s.text).join("");
    expect(marked).toBe("지금 빚투로라도 들어가야 한다는");
  });

  it("공백이 압축된 인용문을 줄바꿈 있는 원문에서도 찾는다", () => {
    // 원문에는 줄바꿈이 있지만 인용문은 단일 스페이스로 압축돼 저장된다
    const body = "제목\n원금 보장 약속입니다";
    const segs = segmentText(body, [f("원금 보장")]);
    expect(segs.some((s) => s.finding && s.text === "원금 보장")).toBe(true);
  });
});

describe("cleanQuote — … 와 공백을 벗긴다", () => {
  it("앞뒤 말줄임표를 벗긴다", () => {
    expect(cleanQuote("…원금 보장…")).toBe("원금 보장");
  });
  it("내부 공백을 단일 스페이스로 압축한다", () => {
    expect(cleanQuote("  원금   보장  ")).toBe("원금 보장");
  });
  it("빈 값·null 은 빈 문자열", () => {
    expect(cleanQuote(null)).toBe("");
    expect(cleanQuote("")).toBe("");
  });
});

describe("isLocated — 소견이 본문에서 위치를 잡히는가", () => {
  const fields = ["제목입니다", "요약입니다", "원금 보장 약속을 드립니다"];
  it("본문에 있으면 true (…·공백 정규화 거쳐)", () => {
    expect(isLocated(fields, f("…원금 보장…"))).toBe(true);
  });
  it("없으면 false — '문장을 짚지 못한 소견'으로 간다", () => {
    expect(isLocated(fields, f("상승 233% / 90일"))).toBe(false);
  });
  it("빈 인용문(IRIS 전체 판정)은 false", () => {
    expect(isLocated(fields, f(""))).toBe(false);
  });
});
