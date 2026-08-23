"use client";

import { useCallback, useEffect, useState } from "react";
import { WhyBody, WhyGroup, WhyToggle } from "../../Why";
import a from "../../admin.module.css";
import s from "../irisStatus.module.css";

/**
 * **IRIS 상세 — 계기판이 접어 둔 것을 펴는 자리** (2026-08-23 창업자 지시).
 *
 * 계기판(`StudentValvePanel`)은 매일 보는 화면이라 `IRIS.v5 ✓` 두 조각만 남겼다.
 * 나머지는 지운 것이 아니라 여기로 옮겼다 — 되짚을 때 오는 자리다.
 *
 * ── 값을 다시 계산하지 않는다 ───────────────────────────────────
 * 서버 컴포넌트로 만들어 `studentMode()` · `usable()` 을 여기서 또 부르면 **같은
 * 질문의 답이 두 곳에서 나오고** 언젠가 갈라진다(계기판 주석의 같은 이유).
 * 라우트가 계약의 원천이므로 계기판과 **같은 엔드포인트**를 읽는다.
 */

interface Student {
  mode: "live" | "shadow" | "off";
  reviewerId: string | null;
  usable: boolean;
  /** 한 번 어긋났지만 아직 결근은 아니다 — 두 번 연속이어야 선언한다 (B안) */
  pendingFailure?: boolean;
  unavailableReason?: string | null;
  modelSha: string | null;
  name?: string | null;
  run?: string | null;
  promoted: { sha: string; at: string } | null;
  promotionMatches: boolean | null;
  /** 검수 기록에 실제로 박히는 표식 — 서버가 조립한다(화면이 rule+ 를 이어 붙이지 않는다) */
  reviewerStamp?: string | null;
}

interface Board {
  outageSince: string | null;
  outageHolds: number;
  bypass: { active: boolean; until: string | null };
  student: Student;
}

const MODE_LABEL: Record<Student["mode"], string> = {
  live: "근무 중 (소견이 보류를 만든다)",
  shadow: "연수 중 (판정하되 기록만)",
  off: "미출근 (규칙 단독 검수)",
};

function Row({
  label,
  sub,
  children,
}: {
  label: string;
  /** 라벨 아래 한 줄 — 오른쪽 값이 둘일 때 **무엇이 무엇인지**를 왼쪽에서 짝지어 준다 */
  sub?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className={a.row} style={{ padding: "8px 0", alignItems: "flex-start" }}>
      <span style={{ minWidth: 128, color: "var(--text-muted)" }}>
        {label}
        {sub && (
          <span style={{ display: "block", fontSize: 11.5, color: "var(--text-faint)", marginTop: 3 }}>
            {sub}
          </span>
        )}
      </span>
      <span style={{ textAlign: "right", flex: 1 }}>{children}</span>
    </div>
  );
}

export function IrisDetail() {
  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      // 상세 화면도 **여는 순간**이라 캐시 없이 다시 잰다 — 원인을 보러 온 사람에게
      // 어제 값을 보여 주면 그 화면의 목적이 사라진다 (2026-08-23). 이 화면은 폴링하지
      // 않으므로 이 한 번이 전부다
      const res = await fetch("/api/admin/compliance/student-valve?fresh=1");
      return res.ok ? ((await res.json()) as Board) : null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const next = await load();
      if (!alive) return;
      if (next) setBoard(next);
      else setFailed(true);
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  if (failed) {
    return <div className={`${a.note} ${a.noteNeg}`}>계기판을 읽지 못했습니다.</div>;
  }
  if (!board) return <div className={a.note}>불러오는 중…</div>;

  const { student } = board;

  return (
    <>
      {/* **상태는 제목 옆 칩 하나로** (2026-08-23 창업자 지시).
          예전에는 제목에 물음표, 그 아래 카드에 `출근` + 같은 칩이 또 있었다 — 같은
          사실이 세 곳에 흩어져 있었던 셈이다. 제목 줄에 붙이면 이 화면에 들어선 순간
          **첫 줄에서 답이 난다**. 물음표는 걷었다: 그 안의 설명은 아래 신원·도장 칸이
          이미 값과 함께 말하고 있어, 접힌 문단은 같은 말을 한 번 더 하는 자리였다 */}
      <div className={a.sech}>
        <div className={a.sechTitle}>
          IRIS
          <span className={a.rowTags} style={{ marginLeft: 8 }}>
            {/* **세 번째 상태가 있다** (2026-08-23 창업자 확정 B안) — 한 번 어긋났지만
                아직 결근은 아닌 자리. 근무 중이라고 하면 화면이 거짓말이고 결근이라고
                하면 헛걸음 하나로 문자가 나간다. 색은 어느 쪽도 아닌 회색이다 */}
            <span
              className={`${s.stateChip} ${
                student.pendingFailure ? "" : student.usable ? s.stateOn : s.stateOff
              }`}
            >
              {/* 문구를 이어 붙이지 않는다 — `근무 중` 을 앞에 덧대니 `근무 중 근무 (…)`
                  가 됐다. 상태 이름은 MODE_LABEL 한 곳에만 있어야 한다 */}
              {student.pendingFailure
                ? "확인 중 (한 번 응답이 없었다)"
                : student.usable
                  ? MODE_LABEL[student.mode]
                  : "결근 중"}
            </span>
          </span>
        </div>
      </div>

      {/* **결근일 때만 카드를 그린다** — 사유는 알림이 상태가 바뀌는 순간 한 번만 보내므로,
          나중에 고치러 온 사람에게는 이 줄이 유일한 단서다. 근무 중이면 위 칩이 이미
          전부라, 빈 카드를 남겨 두면 읽을 것 없는 상자가 하나 는다 */}
      {(!student.usable || student.pendingFailure) && (
        <div className={a.card}>
          <div className={a.row}>
            <div className={a.ttl}>
              <span className={s.alert} aria-hidden="true">
                !
              </span>{" "}
              {student.pendingFailure ? "확인 중" : "결근"}
            </div>
            <span className={a.rowTags}>
              <span className={a.chip}>{MODE_LABEL[student.mode]}</span>
            </span>
          </div>
          {student.unavailableReason && (
            <div className={`${a.note} ${a.noteNeg}`}>
              <b>사유</b> — {student.unavailableReason}
            </div>
          )}
        </div>
      )}

      {/* 신원 — 이름·지문·승격 기록. 셋이 서로를 검사한다 */}
      <div className={a.card}>
        {/* **이름 아래에 표식을 그대로 둔다** (2026-08-23 창업자 지시).
            "파일이 들고 온 값" 이라는 설명을 걷어낸 자리다 — 그 문장은 출처를 말할 뿐
            **확인할 것을 주지 않았다.** 표식은 검수 기록에 실제로 박히는 문자열이라,
            위 이름이 그 안에 그대로 들어 있는 것이 곧 "이 이름이 참"이라는 증거다.
            라벨을 왼쪽에 짝지어 두는 이유: 오른쪽에 값이 둘인데 왼쪽이 하나면
            아래 문자열이 이름의 부연인지 다른 값인지 알 수 없다 */}
        <WhyGroup>
          <Row
            label="모델명"
            sub={
              student.reviewerStamp ? (
                <>
                  검수 기록 표식
                  <WhyToggle />
                </>
              ) : undefined
            }
          >
            <b>{student.name ?? "—"}</b>
            {student.reviewerStamp && (
              <div className={s.stampCode} style={{ marginTop: 3 }}>
                {student.reviewerStamp}
              </div>
            )}
          </Row>
          {/* **조각마다 무엇인지** — 아래 있던 카드를 여기로 접어 넣었다 (창업자 지시).
              값이 두 곳에 있으면 하나는 반드시 낡으므로, 값은 위 한 줄에만 두고
              읽는 법만 물음표 뒤로 넣는다 */}
          <WhyBody className={a.meta}>
            <span>
              <code>rule</code> — 규칙 엔진(정규식·학습 표현). <b>늘 참여합니다</b>
            </span>
            <span>
              <code>student:</code> — 로컬 검사기라는 뜻. 외부 AI 는 <code>claude:</code>
            </span>
            <span>
              <code>IRIS.v5</code> — 모델 파일이 들고 온 이름(<code>config.json</code>)
            </span>
            <span>
              <code>@t0.7</code> — 임계값. <b>모델이 아니라 설정</b>이라 이 값만 바꿔도
              판정이 달라집니다(실측 t0.5 탐지 24% · t0.7 6%)
            </span>
            <span>
              <code>/L7</code> — 켜진 라벨 수. 8종을 낼 수 있고 그중 졸업한 것만 켭니다
            </span>
          </WhyBody>
        </WhyGroup>
        <Row label="적재 지문">
          <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{student.modelSha ?? "—"}</code>
          {/* **어떻게 만든 값인지가 아니라 무엇인지를 적는다** (2026-08-23 창업자 지시).
              "메모리에 올린 파일을 통째로 계산한"은 만드는 과정을 말할 뿐이라, 읽는
              사람이 이 줄로 무엇을 할 수 있는지가 안 나온다. **파일마다 다른 번호**라는
              한 마디가 그 아래 `대조` 줄(적재 지문 = 승격 기록)을 곧바로 이해시킨다 */}
          <div style={{ fontSize: 12, color: "var(--text-faint)" }}>파일 고유의 번호입니다</div>
        </Row>
        <Row label="승격 기록">
          {student.promoted ? (
            <>
              <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{student.promoted.sha}</code>
              <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
                {new Date(student.promoted.at).toLocaleString("ko-KR")}
              </div>
            </>
          ) : (
            "— 아직 승격 명령을 거친 적이 없습니다"
          )}
        </Row>
        <Row label="대조">
          {student.promotionMatches === true ? (
            <span className={s.ok}>✓ 적재 지문 = 승격 기록</span>
          ) : student.promotionMatches === false ? (
            <b style={{ color: "#c4303b" }}>⚠ 어긋납니다 — 승격 명령 없이 올라온 모델입니다</b>
          ) : (
            "대조할 상대가 없습니다"
          )}
        </Row>
      </div>

      {/* **회차 기록 카드는 걷었다** (2026-08-23 창업자 판단).
          `run` 은 "이 회차에 무엇이 달라졌나"라 성적이 움직인 이유를 찾을 때 첫 단서가
          되는데, 그 쓸모는 **회차가 둘 이상일 때** 생긴다. 모델이 r5 하나뿐인 지금은
          비교할 상대가 없어 고정된 문장 하나가 자리만 차지했다.

          값이 사라진 것은 아니다 — 학습 대장(`training/ledger.jsonl`)과 `/health` 의
          `run` 에 그대로 있고, 라우트도 계속 실어 보낸다. 재학습이 한 번이라도 돌면
          그때 되살린다(그때는 이전 회차와 나란히 놓는 편이 맞을 것이다).

          ⚠ 되살릴 때 **이 문장을 이름 자리에 쓰지 말 것** — 2026-08-22 에 그렇게 해서
          근무자 이름 칸에 회차 문장이 통째로 떴다. 이름은 `name`, 이 문장은 `run` 이다
          (회신 14호가 칸을 나눈 이유) */}
    </>
  );
}
