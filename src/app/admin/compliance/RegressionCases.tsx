"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RISK_CATEGORY_LABEL, type RiskCategory } from "@/domain/compliance";
import { performOperatorRecheck } from "../operatorRecheck";
import a from "../admin.module.css";

/**
 * 졸업이 남긴 **회귀 시험 문항** — 그리고 그중 잘못 쓴 것을 빼는 문(격리).
 *
 * ── 이 화면이 잘못 태어나기 가장 쉬운 자리다 ────────────────────
 * 문항을 전부 늘어놓고 각각에 [격리] 버튼을 달면, 그건 막고 싶었던 짓("ARGOS가 틀리는
 * 문항 지우기")에 정확히 필요한 도구다. 그래서 **격리 버튼은 후보에만 붙는다.**
 *
 * 후보의 정의는 서버가 준 세 칸에서 나온다 (4회차 §3 → 회신 4호):
 *
 *   서로 다른 모델 2개 이상에서 실패  →  문항이 잘못 쓰였을 가능성   (격리 후보)
 *   이번 모델에서만 실패              →  모델이 못 배운 것            (격리 금지 — 재학습할 것)
 *   실패한 적 없음                    →  멀쩡한 문항                  (건드릴 이유 없음)
 *
 * `gateFailCount` 는 **서로 다른 지문에서의 실패 횟수**다(같은 모델 두 번은 증거가
 * 두 배가 아니다) — 그래서 화면은 이력 표 없이 이 숫자 하나만 읽으면 된다.
 *
 * ── 문항 전문을 그린다 (4회차 §4-a → 회신 4호) ──────────────────
 * 채점지 원칙이 금지하는 것은 **학습 자료로 내보내는 것**이지 운영자 열람이 아니다.
 * 격리 판단에는 문장 뒷부분이 필요하다(왜 잘못 썼는지가 거기 있을 수 있다).
 * 다만 사람이 복사해 나르는 경로가 유일한 유출구라, 그 주의만 한 줄 남긴다.
 */

export interface CaseRow {
  id: string;
  text: string;
  expectViolation: boolean;
  category: string | null;
  gateFailCount: number;
  lastGateFailAt: string | null;
  lastGateFailSha: string | null;
}

/** 서로 다른 모델 몇 개에서 떨어져야 "문항이 이상하다"로 볼 것인가 */
const QUARANTINE_CANDIDATE_FAILS = 2;

export function RegressionCases({ cases }: { cases: CaseRow[] }) {
  const [open, setOpen] = useState(false);
  if (cases.length === 0) return null;

  const candidates = cases.filter((c) => c.gateFailCount >= QUARANTINE_CANDIDATE_FAILS);

  if (!open) {
    return (
      <button type="button" className={`${a.btn} ${a.btnGhost}`} onClick={() => setOpen(true)}>
        회귀 시험 문항 {cases.length}개 보기
        {candidates.length > 0 && ` — ${candidates.length}개가 여러 모델에서 떨어졌습니다`}
      </button>
    );
  }

  return (
    <div className={a.branch} style={{ marginTop: 10 }}>
      <div className={a.lbl}>
        회귀 시험 문항 {cases.length}개
        <small>재학습한 모델은 여기서 하나라도 틀리면 채택되지 않습니다</small>
      </div>

      {/* 유출구는 기계가 아니라 사람이다 — 그 한 줄만 남긴다 */}
      <div className={a.note}>
        이 문장들은 <b>채점지</b>입니다 — 교사 세션·합성 지시문에 붙여넣지 마세요. 학습
        자료로 새어 들어가면 시험이 시험 구실을 못 합니다.
      </div>

      {cases.map((c) => (
        <CaseCard key={c.id} row={c} />
      ))}

      <button type="button" className={`${a.btn} ${a.btnGhost}`} onClick={() => setOpen(false)}>
        접기
      </button>
    </div>
  );
}

function CaseCard({ row }: { row: CaseRow }) {
  const candidate = row.gateFailCount >= QUARANTINE_CANDIDATE_FAILS;
  // 한 모델에서만 떨어진 것은 아직 **모델 쪽 문제**로 본다.
  //
  // 회신 4호는 `lastGateFailSha === 현재 modelSha` 로 가르라고 했지만, 그 비교의
  // 목적("격리 후보로 띄우지 말 것")은 후보 문턱(서로 다른 모델 2개)이 이미 달성한다.
  // 남는 것은 **문구뿐**인데, 현재 지문은 사이드카가 답할 때만 있다(지금은 null) —
  // 지문에 기대면 그 문구가 **필요한 순간에 정확히 사라진다.** 그래서 지문 없이
  // 참인 말만 한다: 한 번은 아직 근거가 아니다
  const notYetEvidence = row.gateFailCount === 1;

  return (
    <div
      className={a.card}
      style={{
        marginTop: 8,
        ...(candidate ? { borderLeft: "4px solid var(--warn)" } : {}),
      }}
    >
      <div className={a.row}>
        <span className={`${a.chip} ${row.expectViolation ? a.chipNeg : ""}`}>
          {row.expectViolation ? "위반이어야 함" : "정상이어야 함"}
        </span>
        {row.gateFailCount > 0 && (
          <span className={`${a.chip} ${candidate ? a.chipWarn : ""}`}>
            서로 다른 모델 {row.gateFailCount}개에서 실패
          </span>
        )}
      </div>

      {/* 전문 그대로 — 자르면 격리 판단의 재료가 잘린다 */}
      <p className={a.quote} style={{ margin: "8px 0 0" }}>
        {row.text}
      </p>
      {row.category && (
        <div className={a.meta}>
          <span>기대 유형 {RISK_CATEGORY_LABEL[row.category as RiskCategory] ?? row.category}</span>
          {row.lastGateFailAt && (
            <span>마지막 실패 {new Date(row.lastGateFailAt).toLocaleDateString("ko-KR")}</span>
          )}
        </div>
      )}

      {notYetEvidence && (
        <div className={a.note}>
          <b>한 모델에서만 떨어졌습니다 — 아직 문항이 잘못됐다는 근거가 아닙니다.</b> 지금은
          ARGOS가 못 배운 쪽에 가까우니 재학습에 넣으십시오. 다른 모델에서도 떨어지면 그때
          격리 후보로 올라옵니다.
        </div>
      )}

      {candidate ? (
        <QuarantineForm caseId={row.id} text={row.text} fails={row.gateFailCount} />
      ) : (
        // **격리 버튼을 아예 그리지 않는다.** 비활성 버튼으로 두면 "언젠가 누를 수 있는
        // 것"으로 읽히고, 문항마다 버튼이 있는 화면이 되어 막으려던 그 도구가 된다
        row.gateFailCount === 0 && (
          <p className={a.hint} style={{ color: "var(--text-faint)" }}>
            게이트에서 떨어진 적이 없습니다.
          </p>
        )
      )}
    </div>
  );
}

/**
 * 격리 요청 — 사유를 쓰게 하고, 되돌릴 수 없다는 사실을 누르기 **전에** 말한다.
 * 1인 운영 모드면 서버가 `RECHECK_REQUIRED` 로 돌려주고 화면이 지문을 띄운다.
 */
function QuarantineForm({ caseId, text, fails }: { caseId: string; text: string; fails: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(recheckToken?: string) {
    if (!recheckToken && !window.confirm(`격리하면 이 문항은 시험셋에서 영구히 빠집니다. 되돌릴 수 없습니다. 진행할까요?\n\n"${text.slice(0, 40)}…"`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance/quarantine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId, reason: reason.trim(), recheckToken }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "APPROVAL_PENDING") {
          // **실패가 아니라 절차의 절반이다** — 오류 색으로 그리지 않는다
          setNotice(json.error);
        } else if (json.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 1인 운영 모드 — 두 번째 사람 대신 지문·얼굴이 선다. 받은 표를 실어 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await submit(recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
        } else {
          setError(json.error ?? "격리하지 못했습니다");
        }
        return;
      }
      router.refresh();
    } catch {
      setError("서버에 닿지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className={`${a.btn} ${a.btnLine}`}
        style={{ marginTop: 8 }}
        onClick={() => setOpen(true)}
      >
        격리 요청 — 서로 다른 모델 {fails}개가 이 문항에서 떨어졌습니다
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <div className={`${a.note} ${a.noteWarn}`}>
        <b>격리하면 이 문항은 회귀 시험셋에서 영구히 빠집니다. 되돌릴 수 없습니다.</b>{" "}
        다음 재학습부터 이 문항으로는 ARGOS를 시험하지 않습니다. 기록(누가·언제·왜)은 남습니다.
        <br />
        <br />
        <b>문항이 잘못 쓰였을 때만</b> 격리하십시오 — ARGOS가 못 배운 것이라면 여기서 뺄 것이
        아니라 재학습에 넣어야 합니다.
      </div>
      <div className={a.field}>
        <textarea
          className={a.textarea}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={1000}
          placeholder="격리 사유 — 이 문항이 왜 잘못 쓰였는지 적어 주세요"
          aria-label="격리 사유"
        />
      </div>
      {error && <p className={a.error}>{error}</p>}
      {notice && <div className={a.note}>{notice}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className={`${a.btn} ${a.btnGhost}`}
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          취소
        </button>
        <button
          type="button"
          className={a.btn}
          onClick={() => submit()}
          disabled={busy || !reason.trim()}
        >
          🔒 격리 — 되돌릴 수 없습니다
        </button>
      </div>
      {!reason.trim() && (
        <div className={a.gate}>
          사유를 적어야 합니다 — 나중에 &ldquo;왜 뺐나&rdquo;에 답하는 유일한 기록입니다
        </div>
      )}
    </div>
  );
}
