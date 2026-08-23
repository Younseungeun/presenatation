import Link from "next/link";
import { ABUSE_SUSPEND_REPORTERS } from "@/domain/abuseSuspension";
import {
  ABUSE_CATEGORY_CLAIM,
  ABUSE_CATEGORY_LABEL,
  type AbuseCategory,
  type AbuseReportGroup,
} from "@/server/abuseReportService";
import type { AbuseGroupDetail } from "@/server/abuseGroupDetail";
import a from "./admin.module.css";
import { AbuseGroupResolve } from "./AbuseGroupResolve";
import { DirectMessage } from "./DirectMessage";
import { ReviewForm } from "./abuse-reports/ReviewForm";

import { FlaggedBody } from "./FlaggedBody";

// **이용자가 잡은 것 — 리포트 화면의 '본문' 탭에 산다** (2026-08-19 사용자 지시).
//
// 처음엔 신고를 별도 화면에 붙였는데, 그건 이 콘솔이 세운 분류 축
// ("이 일을 끝내려면 무엇을 봐야 하는가")을 어긴 것이었다. 신고를 판단하려면
// **그 리포트의 본문을 읽어야 한다** — 검수 보류 건을 판단할 때와 같은 재료, 같은 화면이다.
//
// 검수 보류와 나란히 두되 **묶음은 가른다**. 시점이 정반대이기 때문이다:
//   · 검수 모델이 세운 것 = 게시 **전**. 아직 아무도 못 샀다
//   · 이용자가 잡은 것   = 게시 **후**. 검수가 **놓친 것(미탐)**이고 이미 팔린 뒤다
// 두 번째가 늘 더 급하다 — 돈이 오갔고, 확인되면 강제 철회로 전액 환불이 나간다.
//
// ── 줄과 상세를 나눈다 (시안 rp-body → rp-3) ──────────────────────
// 목록은 **훑는 것**이고 상세는 **읽는 것**이다. 처음부터 펼쳐 두면 신고 셋만 있어도
// 화면이 본문·인용·폼으로 가득 차 "오늘 몇 건인가"가 스크롤 길이가 된다.
// 펼침은 URL(`?open=`)에 둔다 — 판단을 내리면 화면이 새로 그려지는데, 상태를 컴포넌트가
// 들고 있으면 그때 접혀 버려 "내가 방금 뭘 눌렀지"가 된다.

export function AbuseUserCaught({
  groups,
  openId,
  detail,
  now,
}: {
  groups: AbuseReportGroup[];
  openId?: string;
  detail: AbuseGroupDetail | null;
  now: Date;
}) {
  if (groups.length === 0) {
    return <div className={a.empty}>이용자 신고로 들어온 건이 없습니다.</div>;
  }

  return (
    <>
      {groups.map((g) => {
        const key = g.reportId ?? g.reports[0].id;
        const open = openId === key;
        // 신고자가 **가장 많이 고른** 유형 — 줄에도 카드 머리에도 하나만 실린다.
        //
        // 전에는 `g.reports[0].category`, 즉 **먼저 담긴 신고의 유형**이었다. 신고
        // 셋이 서로 다른 유형을 골랐을 때 그 하나가 대표가 될 근거가 없고, 조회
        // 순서는 보장되지도 않는다. 아래에 신고자별 유형을 줄줄이 펼친 지금은
        // 머리의 칩과 아래 줄들이 어긋나 보이기까지 한다 (2026-08-20)
        const topCategory = topPicked(g.reports.map((r) => r.category));
        // 가장 오래된 신고가 이 건의 나이다 — 마지막 신고가 아니라. 리서처가 잃고 있는
        // 시간은 첫 신고가 아니라 판매가 멈춘 순간부터지만, 큐에 앉아 있는 시간은 이쪽이다
        const oldest = g.reports.reduce(
          (min, r) => (new Date(r.createdAt) < min ? new Date(r.createdAt) : min),
          new Date(g.reports[0].createdAt),
        );
        const elapsed = briefElapsed(oldest, now);

        if (!open) {
          return (
            <Link
              key={key}
              href={`/admin/compliance?tab=body&open=${key}`}
              className={`${a.lite} ${g.suspended ? a.stripeNeg : a.stripeWarn}`}
              scroll={false}
            >
              <span className={a.liteMain}>
                <span className={a.liteName}>{g.title}</span>
                {g.reports[0].researcherName && (
                  <span className={a.liteSub}>
                    {g.reports[0].researcherName} · {g.reports[0].tierLabel} · 판매{" "}
                    {g.reports[0].salesCount}건
                  </span>
                )}
                <span className={a.liteTags}>
                  <span className={a.voice}>◍ 신고자 {g.reporterCount}명</span>
                  {topCategory && (
                    <span className={a.chip}>
                      {ABUSE_CATEGORY_LABEL[topCategory as AbuseCategory] ?? topCategory}
                    </span>
                  )}
                  {g.suspended && <span className={`${a.chip} ${a.chipNeg}`}>⏸ 판매 멈춤</span>}
                </span>
              </span>
              <span className={a.liteRight}>
                <span className={`${a.chip} ${g.suspended ? a.chipNeg : ""}`}>{elapsed}</span>
                <span className={a.go}>›</span>
              </span>
            </Link>
          );
        }

        return (
          <div key={key} className={`${a.card} ${g.suspended ? a.stripeNeg : a.stripeWarn}`}>
            {/* **신고자 쪽 사실은 신고자 쪽에 모은다** (2026-08-20 사용자 지시).
                유형은 리서처 줄(이름·등급·판매)에 끼어 있었는데, 그 줄은 **리포트가
                누구 것인가**를 말하고 유형은 **신고자가 무엇을 봤는가**를 말한다.
                한 줄에 섞이면 "신고자가 고른 유형:"이라고 매번 이름표를 붙여
                누구의 말인지 밝혀야 했다 — 신고자 수 옆으로 옮기면 그 이름표가
                필요 없어지고, 줄 목록(.liteTags)에서 이미 쓰던 배치와도 같아진다 */}
            <div className={a.row}>
              <span className={a.ttl}>{g.title}</span>
              <span className={a.rowTags}>
                <span className={a.voice}>
                  ◍ 신고자 {g.reporterCount}명 · {elapsed} 경과
                </span>
                {topCategory && (
                  <span className={a.chip}>
                    {ABUSE_CATEGORY_LABEL[topCategory as AbuseCategory] ?? topCategory}
                  </span>
                )}
              </span>
            </div>
            {g.reports[0].researcherName && (
              <div className={a.meta}>
                <span>
                  {g.reports[0].researcherName} · {g.reports[0].tierLabel} · 판매{" "}
                  {g.reports[0].salesCount}건
                </span>
              </div>
            )}

            {/* **멈춤 안내 문단은 두지 않는다** (2026-08-20 사용자 지시).
                같은 말이 세 곳에서 반복되고 있었다: 줄의 `⏸ 판매 멈춤` 칩이 상태를
                말하고, 묶음 머리의 물음표가 "신고자 3명이면 저절로 멈춘다"는 규칙을
                말한다. 그 둘이 있으면 카드 안의 문단은 읽히지 않고 자리만 차지한다 —
                그리고 매번 지나치는 문단이 하나 늘면 정작 붉은 줄이 안 튄다 */}

            {/* 발췌만 — 걸린 문구는 붉게. 누르면 이용자가 본 화면이 **자기 화면에서**
                열린다(시안 scr-rp-full). 여기 통째로 깔면 카드 하나가 화면 몇 개
                길이가 되고, 줄과 상세를 나눈 이유가 그대로 무너진다 */}
            {detail && <FlaggedBody detail={detail} />}

            {/* **판단은 그룹에 하나다.** 신고 셋은 한 판단의 세 증거지 세 개의 판단거리가
                아니다 — 확인이면 강제 철회·미탐 기록·전원 통지·보상까지 이 폼 하나가 끝낸다.
                들어온 신고 목록은 **버튼을 누른 뒤 뜨는 확인 창**으로 넘겼다
                (2026-08-20 사용자 지시) — 아래 ReportersPart 주석 참고 */}
            {g.reportId ? (
              <AbuseGroupResolve
                reportId={g.reportId}
                reporterCount={g.reporterCount}
                reporters={<ReportersPart g={g} />}
                researcherUserId={g.reports[0].researcherUserId}
                researcherName={g.reports[0].researcherName}
              />
            ) : (
              // 리포트가 특정되지 않은 자유 입력 신고 — 내릴 상품이 없어 그룹 판단이
              // 없고, 따라서 확인 창을 띄울 버튼도 없다. 여기서는 목록이 카드에 남고
              // 신고 한 건마다 따로 처리한다
              <ReportersPart g={g} withForms />
            )}

            {/* 접기 — 검수 카드와 같은 자리, 같은 모양 (2026-08-20 사용자 지시).
                펼친 카드를 줄로 되돌릴 길이 없으면 목록으로 돌아가려고 다른 줄을
                누르게 되고, 그러면 접는 대신 **다른 것이 펼쳐진다** */}
            <Link href="/admin/compliance?tab=body" className={a.fold} scroll={false}>
              접기 ⌃
            </Link>
          </div>
        );
      })}
    </>
  );
}

/**
 * 들어온 신고 — **누가, 언제, 무엇을 걸고 신고했는가.**
 *
 * ── 왜 카드에서 나갔나 (2026-08-20 사용자 지시) ──────────────────
 * 이 목록은 카드 높이의 절반을 먹으면서 **판단 중에는 대부분 읽히지 않았다.**
 * 운영자가 카드를 열고 하는 일의 순서가 그렇다: 본문의 걸린 문구를 보고, 유형을
 * 고르고, 사유를 적는다. 신고자 셋의 이름과 시각은 그 사이 어디에도 안 쓰인다.
 *
 * 그런데 **딱 한 순간** 결정적으로 쓰인다 — 버튼을 누르는 순간이다. 확인이면 남의
 * 판매가 죽고 전액 환불이 나가고, 기각이면 신고자 셋이 전부 오신고자가 된다.
 * "이 판단이 누구의 말 위에 서 있는가"는 그때 눈앞에 있어야 하는 사실이다.
 * 그래서 목록을 지우지 않고 **그 순간으로 옮겼다**: 늘 펼쳐 두면 안 읽히고,
 * 확인 창에 두면 반드시 읽힌다.
 *
 * `withForms`는 리포트가 특정되지 않은 신고 전용 — 그때는 그룹 판단이 없어
 * 목록이 카드에 남고 건마다 ReviewForm이 붙는다.
 */
function ReportersPart({ g, withForms = false }: { g: AbuseReportGroup; withForms?: boolean }) {
  return (
    <>
      {/* **설명을 붙이지 않는다** (2026-08-20 사용자 지시). `보상은 첫 신고자만 —
          뒤 사람들은 보상 없이 남겼습니다`는 줄마다 붙는 `보상 대상`·`보상 없음`
          칩이 이미 사람별로 말하고 있다. 규칙을 글로 한 번 더 적으면 세 줄을
          읽기 전에 문장을 하나 더 지나야 하고, 지나치는 습관은 칩에도 옮는다 */}
      <div className={a.lbl}>들어온 신고</div>
      {/* **시각과 사람을 한 줄에** (2026-08-20 사용자 지시). 전에는 위에 날짜
          목록, 아래에 이름+내용 목록으로 같은 세 사람이 두 번 나열됐다 —
          읽는 사람이 두 목록을 눈으로 맞춰야 "이 말을 한 게 몇 번째 신고인지"를
          알 수 있었고, 그 맞추기는 아무것도 벌지 못한다 */}
      {[...g.reports]
        .sort((x, y) => +new Date(x.createdAt) - +new Date(y.createdAt))
        .map((r, i) => {
          const crossed = i + 1 === ABUSE_SUSPEND_REPORTERS && g.suspended;
          return (
            <div key={r.id}>
              <div className={a.kv}>
                {/* 시각과 사람만. `— 여기서 판매가 멈췄습니다`는 오른쪽의 붉은
                    `문턱 3명` 칩이 같은 자리에서 같은 말을 한다 (2026-08-20 사용자 지시).
                    덤으로 이름이 긴 줄이 두 줄로 접히던 것도 없어진다 */}
                <span className={a.kvK}>
                  {stamp(r.createdAt)}&nbsp;&nbsp;{r.reporterName}
                </span>
                <span className={`${a.chip} ${crossed ? a.chipNeg : ""}`}>
                  {crossed
                    ? `문턱 ${ABUSE_SUSPEND_REPORTERS}명`
                    : i === 0
                      ? "보상 대상"
                      : "보상 없음"}
                </span>
              </div>
              {/* 무고 이력은 **그 사람 줄 옆에** 있어야 쓸모가 있다 — 따로
                  찾아봐야 하면 안 본다 */}
              {r.reporterRejectedCount > 0 && (
                <div className={a.meta}>
                  <span className={`${a.chip} ${a.chipWarn}`}>
                    ⚠ 이 신고자의 기각 이력 {r.reporterRejectedCount}건
                  </span>
                </div>
              )}
              {/* **그 사람이 무엇을 걸고 신고했는지** (2026-08-20 사용자 지시).
                  전에는 신고자가 쓴 정황·근거(AbuseReport.detail)를 그대로
                  실었는데, 자유 서술이라 사람마다 길이도 결도 달라 **세 줄을
                  나란히 놓고 견줄 수가 없었다.** 판단에 쓰이는 것은 "세 사람이
                  같은 것을 봤나, 다른 것을 봤나"이고 그건 고른 유형이 답한다.
                  누르면 그 사람에게 쪽지를 쓴다 — 답할 상대가 가장 또렷한 자리다 */}
              <DirectMessage
                userId={r.reporterId}
                name={r.reporterName}
                quote={
                  ABUSE_CATEGORY_CLAIM[r.category as AbuseCategory] ??
                  (ABUSE_CATEGORY_LABEL[r.category as AbuseCategory] ?? r.category)
                }
              />
              {withForms && <ReviewForm reportId={r.id} />}
            </div>
          );
        })}
    </>
  );
}

/**
 * 가장 많이 고른 값 — 동수면 **먼저 신고된 쪽**(입력 순서)이 이긴다.
 *
 * 동수 처리에 임의성을 두지 않는 것이 요점이다: 같은 데이터를 두 번 그렸는데 칩이
 * 달라지면, 화면이 데이터가 아니라 조회 순서를 말하고 있다는 뜻이다.
 */
function topPicked(values: string[]): string | undefined {
  const count = new Map<string, number>();
  for (const v of values) count.set(v, (count.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, n] of count) {
    if (best === undefined || n > (count.get(best) ?? 0)) best = v;
  }
  return best;
}

/**
 * 줄에 실을 짧은 경과 — `2일` / `4시간`.
 *
 * `formatElapsed`는 `2일 대기`처럼 끝에 '대기'를 붙인다. 그건 **검수 큐**의 말이다:
 * 거기서는 아무 일도 안 일어난 채 사람을 기다린다. 여기 신고 건은 기다리는 동안
 * **판매가 멈춰 있으므로** '대기'가 아니라 잃고 있는 시간이고, 줄에는 숫자만 둔다
 * (상세에서 '경과'를 붙여 그 뜻을 마저 말한다).
 */
function briefElapsed(from: Date, now: Date): string {
  const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return `${Math.floor(hours / 24)}일`;
}

/**
 * 신고가 들어온 **시각** — `2026.08.19 15:33`.
 *
 * 날짜만으로는 부족하다: 문턱을 넘긴 셋째 신고가 둘째와 같은 날 3분 뒤에 들어왔는지
 * 열두 시간 뒤인지가 이 건의 성격을 가른다(짧은 간격은 담합을 의심할 자리다).
 * 앞자리를 0으로 채우는 이유는 여러 줄이 세로로 놓일 때 자릿수가 흔들리지 않게 하려는 것.
 */
function stamp(d: Date): string {
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}.${p(x.getMonth() + 1)}.${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`;
}

