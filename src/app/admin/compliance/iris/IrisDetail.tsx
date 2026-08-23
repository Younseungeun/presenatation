"use client";

import { useCallback, useEffect, useState } from "react";
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
  unavailableReason?: string | null;
  modelSha: string | null;
  name?: string | null;
  run?: string | null;
  promoted: { sha: string; at: string } | null;
  promotionMatches: boolean | null;
}

interface Board {
  outageSince: string | null;
  outageHolds: number;
  bypass: { active: boolean; until: string | null };
  student: Student;
}

const MODE_LABEL: Record<Student["mode"], string> = {
  live: "근무 (소견이 보류를 만든다)",
  shadow: "연수 중 (판정하되 기록만)",
  off: "미출근 (규칙 단독 검수)",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={a.row} style={{ padding: "8px 0", alignItems: "flex-start" }}>
      <span style={{ minWidth: 128, color: "var(--text-muted)" }}>{label}</span>
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
      {/* 상태 — 계기판의 점이 말하던 것을 여기서는 문장으로 */}
      <div className={a.card}>
        <div className={a.row}>
          <div className={a.ttl}>
            {student.usable ? (
              <span className={s.dot} aria-hidden="true" />
            ) : (
              <span className={s.alert} aria-hidden="true">
                !
              </span>
            )}{" "}
            {student.usable ? "출근" : "결근"}
          </div>
          <span className={a.rowTags}>
            <span className={a.chip}>{MODE_LABEL[student.mode]}</span>
          </span>
        </div>
        {/* 결근이면 사유가 여기 있어야 한다 — 알림은 상태가 바뀌는 순간 한 번뿐이라,
            나중에 고치러 온 사람에게는 이 줄이 유일한 단서다 */}
        {!student.usable && student.unavailableReason && (
          <div className={`${a.note} ${a.noteNeg}`}>
            <b>사유</b> — {student.unavailableReason}
          </div>
        )}
      </div>

      {/* 신원 — 이름·지문·승격 기록. 셋이 서로를 검사한다 */}
      <div className={a.card}>
        <div className={a.ttl}>신원</div>
        <Row label="이름">
          <b>{student.name ?? "—"}</b>
          {student.name && (
            <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
              파일이 들고 온 값입니다 (<code>config.json</code> 의 <code>name</code>) — 설정에
              적힌 이름이 아니라
            </div>
          )}
        </Row>
        <Row label="적재 지문">
          <code style={{ fontSize: 11.5, wordBreak: "break-all" }}>{student.modelSha ?? "—"}</code>
          <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
            사이드카가 실제로 메모리에 올린 파일을 통째로 계산한 값입니다
          </div>
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

      {/* 도장 — 소견에 실제로 박히는 값. 조각마다 무엇인지 풀어 둔다 */}
      <div className={a.card}>
        <div className={a.ttl}>소견에 박히는 도장</div>
        <code className={s.stampCode} style={{ display: "block", margin: "6px 0 10px" }}>
          {student.reviewerId ?? "—"}
        </code>
        <Row label="student:">로컬 검사기 — API 모델은 <code>claude:</code>, 규칙은 <code>rule</code></Row>
        <Row label="@t">
          임계값
          <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
            <b>모델이 아니라 설정입니다.</b> 같은 이름이어도 이 값이 바뀌면 판정이 달라집니다 —
            실측으로 t0.5 에서 탐지 24%, t0.7 에서 6%
          </div>
        </Row>
        <Row label="/L">
          켜진 라벨 수
          <div style={{ fontSize: 12, color: "var(--text-faint)" }}>
            모델은 8종을 낼 수 있고 그중 졸업한 것만 켭니다 — 이것도 설정입니다
          </div>
        </Row>
      </div>

      {/* 회차 기록 — 이름이 아니라 사람이 읽는 문장. 대장과 같은 값 */}
      {student.run && (
        <div className={a.card}>
          <div className={a.ttl}>회차 기록</div>
          <div style={{ marginTop: 6 }}>{student.run}</div>
          <div className={a.note}>
            학습 대장(<code>ledger.jsonl</code>)과 같은 문장입니다. <b>이름이 아닙니다</b> — 도장과
            화면에는 위의 <code>name</code> 을 씁니다. 한때 이 문장이 이름 자리에 들어가
            근무자 이름으로 떴습니다.
          </div>
        </div>
      )}
    </>
  );
}
