import Link from "next/link";
import type { AbuseGroupDetail } from "@/server/abuseGroupDetail";
import a from "./admin.module.css";

// **신고된 문구를 붉게 칠하고, 원문은 따로 연다** (시안 rp-3 → scr-rp-full).
//
// 신고자가 남긴 글은 "어디가 문제인지"에 대한 자기 말이지 본문의 인용이 아니다.
// 판단의 재료는 **본문의 그 문장**이라, 찾아 주지 않으면 운영자가 매번 리포트를
// 따로 열어 눈으로 훑어야 한다.
//
// 다만 여기 두는 것은 **발췌뿐**이다. 이용자가 본 화면 전체를 판단 화면 안에 깔면
// 카드 하나가 화면 몇 개 길이가 되고, 그러면 "오늘 몇 건인가"가 다시 스크롤 길이가
// 된다 — 줄과 상세를 나눈 이유가 그대로 무너진다. 발췌를 누르면 원문이 자기 화면에서
// 열린다.
export function FlaggedBody({ detail }: { detail: AbuseGroupDetail }) {
  const quotes = flaggedQuotes(detail);
  const fullHref = `/admin/compliance?tab=body&open=${detail.reportId}&full=${detail.reportId}`;

  if (quotes.length === 0) {
    // 걸린 문구가 없으면 **문만 남긴다** (2026-08-20 사용자 지시) — "못 찾았다"는 설명은
    // 판단 화면에서 자리를 차지할 만한 사실이 아니다. 칠해 둔 자리가 없다는 것은
    // 원문을 열면 그 자리에서 바로 보이고, 그 화면에 그 한 줄이 이미 있다.
    return (
      <Link href={fullHref} className={a.xref}>
        {/* **문 이름은 가는 곳으로 짓는다** (2026-08-20 사용자 지시). 예전 문구는
            "이용자가 보는 화면 그대로 — 종목·목표가·별점까지"였는데, 그건 저 문이
            어떻게 생겼는지를 설명한 것이지 무엇을 하러 가는지가 아니다.
            여기서 운영자가 하려는 일은 하나 — **본문을 읽는 것**이다 */}
        <span>리포트 본문 보기</span>
        <span className={a.go}>›</span>
      </Link>
    );
  }

  return (
    <>
      {quotes.map((q) => (
        <Link key={q} href={fullHref} className={`${a.quote} ${a.quoteOpen}`}>
          &ldquo;…<b>{q}</b>…&rdquo;
        </Link>
      ))}
      <div className={a.note}>
        신고된 문구는 <b>붉게 칠해</b> 두었습니다. 앞뒤를 함께 읽으세요 — 같은 문장도
        맥락이 다르면 다른 글입니다.
      </div>
    </>
  );
}

/** 규칙·학습 표현이 잡은 문구 — 같은 문구를 두 규칙이 잡아도 한 번만 */
export function flaggedQuotes(detail: AbuseGroupDetail): string[] {
  return [...new Set(detail.flagged.map((f) => f.quote.trim()).filter(Boolean))];
}
