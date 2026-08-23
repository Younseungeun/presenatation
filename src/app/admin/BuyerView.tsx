import type { AbuseGroupDetail } from "@/server/abuseGroupDetail";
import { flaggedQuotes } from "./FlaggedBody";
import a from "./admin.module.css";

// **구매자가 본 그대로** (시안 rp-3의 .uframe).
//
// 신고가 맞는지는 본문만 봐서는 답이 안 난다 — 구매자가 돈 내고 얻은 것은 본문이 아니라
// 종목·목표가·기한까지 붙은 **카드**이고, "본문은 얌전한데 카드만 자극적인" 구조가
// 이 플랫폼의 오래된 사각지대다. 그래서 판단 화면 안에 그 화면을 옮겨 둔다.
//
// ── 이것은 이용자 껍데기가 새어 들어온 것이 **아니다** ──────────────
// 관리 화면과 이용자 화면은 서로 다른 화면이고, 이용자용 장치(판정 팝업·탭바·푸터)는
// /admin에 오지 않는다. 이건 그 규칙의 예외가 아니라 **창문**이다: 테두리와 머리띠로
// 다른 화면임을 표시하고, 안에 쓰는 색·글꼴·클래스는 전부 관리 화면의 것이다
// (admin.module.css의 .uframe~). 이용자 컴포넌트를 가져다 쓰면 그쪽이 바뀔 때
// 이 창문이 같이 흔들리고, 그러면 "이용자가 본 그대로"가 아니라 "지금 이용자 화면"이
// 되어 **그때 팔린 화면**을 재현하지 못한다.
export function BuyerView({ detail }: { detail: AbuseGroupDetail }) {
  const c = detail.card;
  const up = c?.direction === "UP";
  const dirColor = up ? "#c4303b" : "#1763c9";

  return (
    <div className={a.uframe}>
      <div className={a.uframeBar}>
        <span>◉</span>
        이용자가 보는 화면 그대로 — 구매자에게는 이렇게 보입니다
      </div>
      <div className={a.uapp}>
        <div className={a.uback}>‹ 리포트</div>
        <div className={a.uh1}>{detail.title}</div>
        <div className={a.usub}>
          {detail.researcherName} · {detail.summary}
        </div>

        {c && (
          <div className={a.urev}>
            <div className={a.urevHead}>
              <div className={a.urevLogo}>{[...c.assetName][0] ?? "?"}</div>
              <div>
                <div className={a.urevName}>{c.assetName}</div>
                <div className={a.urevTicker}>
                  {c.assetClassLabel} · {c.ticker}
                </div>
              </div>
            </div>
            <div className={a.urevClaim}>
              <span className={a.urevDir} style={{ color: dirColor }}>
                {up ? "▲ 상승" : "▼ 하락"}
              </span>
              {/* 기준가가 아직 없는 소급 확정 카드는 크기를 못 낸다 — 지어내지 않는다 */}
              {c.magnitudePct !== null && (
                <span className={a.urevPct} style={{ color: dirColor }}>
                  {up ? "+" : "−"}
                  {Math.round(c.magnitudePct)}%
                </span>
              )}
            </div>
            {c.basePrice !== null && c.targetPrice !== null && (
              <div className={a.urevPrices}>
                <div className={a.urevCell}>
                  <span className={a.urevK}>기준가</span>
                  <span className={a.urevV}>{money(c.basePrice, c.currency)}</span>
                </div>
                <span className={a.urevArrow} style={{ color: dirColor }}>
                  →
                </span>
                <div className={a.urevCell}>
                  <span className={a.urevK}>목표가</span>
                  <span className={a.urevV} style={{ color: dirColor }}>
                    {money(c.targetPrice, c.currency)}
                  </span>
                </div>
              </div>
            )}
            {c.deadline && (
              <div className={a.urevFoot}>
                <span className={a.urevDday}>D-{dday(c.deadline)}</span>
                <span className={a.urevDeadline}>
                  {new Date(c.deadline).toLocaleDateString("ko-KR")} 시장가로 자동 판정
                </span>
              </div>
            )}
          </div>
        )}

        <div className={a.usec}>리포트 본문</div>
        {/* 걸린 문구는 본문 안에서 형광으로 — 잘라 낸 발췌만 보면 "오픈채팅"이라는
            단어 하나로 판단하게 되는데, 그 단어는 "오픈채팅 유인은 신고 대상입니다"라고
            쓴 정직한 문장에도 들어 있다. 같은 문장도 맥락이 다르면 다른 글이다 */}
        <div className={a.ubody}>
          <Marked text={detail.body} phrases={flaggedQuotes(detail)} />
        </div>

        {/* 이 줄이 이 창문의 정직함이다 — 우리는 지금 남의 유료 본문을 보고 있고,
            그 사실이 화면에 없으면 열람이 습관이 된다 */}
        <div className={a.unote}>운영자 권한으로 검토를 위해 본문을 열람 중입니다.</div>
      </div>
    </div>
  );
}

function dday(deadline: Date): number {
  const ms = new Date(deadline).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** 미국주식을 '원'으로 적으면 그 자체가 거짓말이다 — 통화는 카드가 들고 있다 */
function money(v: number, currency: string): string {
  const n = Math.round(v).toLocaleString();
  return currency === "USD" ? `$${n}` : `${n}원`;
}

/**
 * 본문에서 걸린 문구만 형광으로 칠한다.
 *
 * 정규식을 만들지 않는다 — 인용문에 `(`·`*` 같은 글자가 들어오면 정규식 문법으로
 * 해석돼 엉뚱한 자리가 칠해지거나 예외가 난다. 문자열 찾기를 앞에서부터 되풀이한다.
 */
function Marked({ text, phrases }: { text: string; phrases: string[] }) {
  if (phrases.length === 0) return <>{text}</>;

  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    // 남은 글에서 **가장 먼저 나오는** 문구를 찾는다 — 목록 순서가 아니라 글의 순서다
    let at = -1;
    let hit = "";
    for (const p of phrases) {
      const i = rest.indexOf(p);
      if (i >= 0 && (at < 0 || i < at)) {
        at = i;
        hit = p;
      }
    }
    if (at < 0) {
      parts.push(rest);
      break;
    }
    if (at > 0) parts.push(rest.slice(0, at));
    parts.push(<mark key={key++}>{hit}</mark>);
    rest = rest.slice(at + hit.length);
  }

  return <>{parts}</>;
}
