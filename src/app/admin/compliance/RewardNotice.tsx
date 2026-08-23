"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import a from "../admin.module.css";

// 보상 안내 — **약속을 지키는 일이지 판단이 아니다** (시안 rp-4).
//
//  · 대상 보기    → 누구에게 말을 걸어야 하는지. 연락처는 눌러야 열린다
//  · 안내 완료 기록 → 손으로 한 일을 적는 자리. **이게 없으면 큐가 영영 안 줄어든다**
//
// 안내 완료는 지급 완료가 아니다 — 쿠폰이 생기면 이 목록으로 소급 발행하므로
// "보상 대상"이라는 사실은 그대로 남는다.
export function RewardNotice({
  reportId,
  reporters,
}: {
  reportId: string;
  reporters: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [showTargets, setShowTargets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function done() {
    if (
      !window.confirm(
        `${reporters.length}명에게 안내를 마쳤다고 기록할까요? 이 묶음은 대기 목록에서 내려갑니다.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/abuse-reward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "기록에 실패했습니다");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "기록에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* 연락처는 눌러야 열린다 — 목록을 훑는 동안 남의 주소가 화면에 널려 있을 이유가 없다 */}
      {showTargets && (
        <div className={a.sent}>
          <div className={a.sTag}>안내 대상 · {reporters.length}명</div>
          {reporters.map((r) => (
            <div key={r.id} className={a.sV}>
              {r.name}
            </div>
          ))}
        </div>
      )}
      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${a.btnLine}`}
          onClick={() => setShowTargets((v) => !v)}
        >
          {showTargets ? "대상 접기" : "대상 보기"}
        </button>
        <button
          type="button"
          className={`${a.btn} ${busy ? a.btnLine : a.btnInk}`}
          disabled={busy}
          onClick={done}
        >
          {busy ? "기록 중…" : "안내 완료 기록"}
        </button>
      </div>
      {error && <p className={a.error}>{error}</p>}
    </>
  );
}
