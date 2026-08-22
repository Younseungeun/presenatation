import Link from "next/link";
import { RISK_CATEGORY_LABEL, type RiskCategory } from "@/domain/compliance";
import { GRADUATION_WATCH_DAYS } from "@/server/phraseGraduationService";
import { PhraseToggle } from "./PhraseToggle";
import a from "../admin.module.css";

/**
 * 졸업 관찰 큐 — **졸업 직후 7일이 가장 위험하다.**
 *
 * 졸업하면 사전 보호가 꺼지고 IRIS만 남는다. 뚫린 것을 알아채는 경로가 미탐 신고뿐이면
 * 운영자가 자기 오판을 자기가 발견해야 한다 — 그래서 서버가 졸업한 표현을 7일간 같은
 * 규칙 엔진으로 계속 돌리되 **소견은 내지 않고** 기록만 남긴다.
 *
 * 그 기록이 지금까지 쌓이기만 하고 볼 화면이 없었다. 이 묶음이 그 자리다.
 *
 * ── 읽는 법 ────────────────────────────────────────────────────
 *   나타남 N · IRIS가 놓침 M
 *   M 이 쌓이면 졸업이 성급했다는 증거다 — 사전은 껐는데 IRIS가 못 잡고 있다.
 *   M = 0 이면 IRIS가 넘겨받은 일을 하고 있다는 뜻이라 조용한 것이 정상이다.
 *
 * ── 자리 (확인서 Q3 → 회신 5호 동의) ───────────────────────────
 * 새 탭을 만들지 않고 운영자 사전 화면 위에 얹는다. 졸업은 사전에서 일어나는 일이고
 * 관찰은 그 뒷일이라, 두 화면으로 갈라 두면 졸업시킨 사람이 결과를 보러 갈 곳을
 * 따로 기억해야 한다.
 */

export interface WatchRow {
  id: string;
  phrase: string;
  category: string;
  graduatedAt: Date;
  hitCount: number;
  studentMissCount: number;
  lastHitAt: Date | null;
}

export function GraduationWatch({ rows, now }: { rows: WatchRow[]; now: Date }) {
  if (rows.length === 0) return null;

  return (
    <>
      {rows.map((r) => {
        // **놓친 것이 하나라도 있으면 그것이 이 줄의 제목이다** — 나타난 횟수는
        // 그 다음이다. 조용한 항목과 뚫린 항목이 같은 얼굴이면 큐를 볼 이유가 없다
        const leaking = r.studentMissCount > 0;
        return (
          <div
            key={r.id}
            className={a.card}
            style={leaking ? { borderLeft: "4px solid #c4303b" } : undefined}
          >
            <div className={a.row}>
              <div className={a.ttl}>&ldquo;{r.phrase}&rdquo;</div>
              <div style={{ display: "flex", gap: 6 }}>
                <span className={`${a.chip} ${leaking ? a.chipNeg : ""}`}>
                  {leaking ? `IRIS가 놓침 ${r.studentMissCount}` : "관찰 중"}
                </span>
                <span className={a.chip}>{daysLeft(r.graduatedAt, now)}</span>
              </div>
            </div>
            <div className={a.meta}>
              <span>{RISK_CATEGORY_LABEL[r.category as RiskCategory] ?? r.category}</span>
              <span>
                졸업 {r.graduatedAt.toLocaleDateString("ko-KR")} · 나타남 {r.hitCount}회
              </span>
              {/* 마지막으로 나타난 시각이 없으면 **아직 아무 일도 없었다**는 뜻이다.
                  침묵을 "괜찮다"로 읽을지 "표본이 없다"로 읽을지는 다르므로 구별해 적는다 */}
              <span>
                {r.lastHitAt
                  ? `마지막 ${r.lastHitAt.toLocaleDateString("ko-KR")}`
                  : "아직 한 번도 나타나지 않았습니다"}
              </span>
            </div>

            {leaking ? (
              <div className={`${a.note} ${a.noteNeg}`}>
                이 표현이 <b>{r.hitCount}번 나타났고 그중 {r.studentMissCount}번은 IRIS가
                잡지 못했습니다.</b> 사전은 꺼져 있으므로 그 {r.studentMissCount}건은{" "}
                <b>아무도 막지 않았습니다.</b> 되살리면 사전이 다시 잡습니다 — 회귀 시험
                문항은 그대로 남으므로 IRIS도 계속 시험받습니다.
              </div>
            ) : (
              <div className={a.note}>
                넘겨받은 IRIS가 아직 놓친 것이 없습니다. 관찰 창이 끝나면 이 줄은 사라지고,
                이후에는 미탐 신고가 유일한 발견 경로가 됩니다.
              </div>
            )}

            {/* 되살리기는 활성/비활성 토글과 **같은 동작**이라 같은 컴포넌트를 쓴다 —
                졸업 전용 되살리기 버튼을 따로 만들면 두 개의 되살리기가 생긴다 */}
            <PhraseToggle phraseId={r.id} active={false} graduated />
            <Link href={`/admin/compliance?tab=phrases#p-${r.id}`} className={a.xref}>
              <span>
                사전에서 이 항목 보기 <small>— 대비쌍 6문장이 회귀 시험셋에 있습니다</small>
              </span>
              <span className={a.go}>›</span>
            </Link>
          </div>
        );
      })}
    </>
  );
}

/**
 * 관찰 창이 얼마나 남았나 — 창이 닫히면 발견 경로가 미탐 신고뿐이 된다.
 * 창 길이는 **서버 상수를 그대로 읽는다** (이 파일은 서버 컴포넌트라 직접 import 된다).
 */
function daysLeft(graduatedAt: Date, now: Date): string {
  const passed = Math.floor((now.getTime() - graduatedAt.getTime()) / 86_400_000);
  const left = GRADUATION_WATCH_DAYS - passed;
  return left <= 0 ? "관찰 끝" : `관찰 ${left}일 남음`;
}
