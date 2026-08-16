"use client";

import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import styles from "../../researcher/researcher.module.css";

// 동결 해제 — 확인한 내용을 적어야 실행되고, 그 글이 그대로 승인자의 사유가 된다.
// 첫 실행은 승인 요청으로 멈추는 것이 정상 흐름이다(2인 승인) — 오류 색으로 그리지 않는다.

type FrozenRow = {
  researcherUserId: string;
  displayName: string;
  account: string;
  frozenAt: string;
  frozenBy: string;
};

export function FrozenList({ initial }: { initial: FrozenRow[] }) {
  const [rows, setRows] = useState(initial);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [error, setError] = useState<Record<string, string>>({});

  async function unfreeze(id: string, retried = false) {
    setBusy(id);
    setError((p) => ({ ...p, [id]: "" }));
    setNotice((p) => ({ ...p, [id]: "" }));
    try {
      const res = await fetch("/api/admin/frozen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ researcherUserId: id, reason: (reasons[id] ?? "").trim() }),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.code === "APPROVAL_PENDING") {
          setNotice((p) => ({ ...p, [id]: json.error }));
        } else if (json.code === "RECHECK_REQUIRED" && !retried) {
          // 1인 운영 모드 — 두 번째 사람 대신 지문·얼굴이 선다. 확인되면 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok) {
            await unfreeze(id, true);
            return;
          }
          if (recheck.error) setError((p) => ({ ...p, [id]: recheck.error! }));
        } else {
          setError((p) => ({ ...p, [id]: json.error ?? "해제에 실패했습니다" }));
        }
        return;
      }
      setRows(json.frozen);
    } catch (e) {
      setError((p) => ({ ...p, [id]: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  if (rows.length === 0) {
    return <p className={styles.sub}>동결된 계정이 없습니다.</p>;
  }

  return (
    <>
      {rows.map((r) => (
        <div key={r.researcherUserId} className={styles.card}>
          <div className={styles.cardTop}>
            <div className={styles.cardTitle}>{r.displayName}</div>
            <span className={styles.badge}>동결 {r.frozenAt.slice(0, 10)}</span>
          </div>
          <div className={styles.meta}>
            <span>{r.account}</span>
            <span>건 사람: {r.frozenBy}</span>
          </div>
          <textarea
            className={styles.textarea}
            rows={2}
            maxLength={300}
            value={reasons[r.researcherUserId] ?? ""}
            onChange={(e) =>
              setReasons((p) => ({ ...p, [r.researcherUserId]: e.target.value }))
            }
            placeholder="무엇으로 본인을 확인했는지 (예: 8/17 14:00 유선 통화로 본인 확인, 계좌 재등록 안내함)"
          />
          <div className={styles.formActions}>
            <button
              className={styles.primaryBtn}
              onClick={() => unfreeze(r.researcherUserId)}
              disabled={busy === r.researcherUserId || !(reasons[r.researcherUserId] ?? "").trim()}
            >
              {busy === r.researcherUserId ? "실행 중…" : "동결 해제"}
            </button>
          </div>
          <p className={styles.sub}>
            해제에는 <strong>다른 운영자의 승인</strong>이 필요합니다 — 첫 실행은 승인
            요청을 올리고, 승인되면 여기서 다시 실행하세요. 해제는 감사 기록에 남습니다.
          </p>
          {notice[r.researcherUserId] && (
            <p className={styles.sub}>{notice[r.researcherUserId]}</p>
          )}
          {error[r.researcherUserId] && (
            <p className={styles.error}>{error[r.researcherUserId]}</p>
          )}
        </div>
      ))}
    </>
  );
}
