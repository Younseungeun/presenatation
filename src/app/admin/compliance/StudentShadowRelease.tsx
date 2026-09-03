"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import a from "../admin.module.css";

// ARGOS 자동 격하를 **사람이 푼다** (10차 검토 I-6).
//
// 거는 것은 시스템이고 푸는 것은 사람이다. 자동 복구를 두지 않는 이유는 원칙이 아니라
// 관측의 성질이다 — ARGOS를 끄면 ARGOS의 성적을 만들 재료가 끊기므로, 끈 상태에서 잰
// 값은 "좋아졌다"가 아니라 "모른다"인데 순이익 함수는 그 둘을 같은 얼굴로 돌려준다.
// 매번 다시 재서 켜고 끄면 껐다 켰다가 영원히 반복된다.
//
// 그래서 이 버튼이 뜻하는 것은 "지금 괜찮아 보인다"가 아니라
// **"다시 재서 채택선을 통과시켰다"**이고, 확인 문구가 그 사실을 묻는다.

export function StudentShadowRelease() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<{ error: string; hint?: string } | null>(null);

  async function release() {
    if (
      !confirm(
        "ARGOS을 다시 켭니다.\n\n" +
          "재학습하고 npm run eval:student 로 채택선을 다시 통과시켰습니까?\n" +
          "격하된 동안에는 ARGOS의 성적을 잴 재료가 없어, 지금 지표가 좋아 보이는 것은 " +
          "좋아졌다는 뜻이 아니라 모른다는 뜻입니다.",
      )
    )
      return;
    setBusy(true);
    setBlocked(null);
    try {
      const res = await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "RELEASE_STUDENT_SHADOW" }),
      });
      // **막혔으면 이유를 보여준다** (11차 K-4). 조용히 아무 일도 안 일어나면
      // 운영자는 버튼이 고장 났다고 읽고, 그러면 관문이 방어가 아니라 버그가 된다.
      if (!res.ok) {
        setBlocked((await res.json().catch(() => null)) ?? { error: "해제하지 못했습니다" });
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className={a.btnrow}>
        <button type="button" className={`${a.btn} ${a.btnLine}`} onClick={release} disabled={busy}>
          {busy ? "처리 중…" : "자동 격하 해제 — ARGOS 다시 켜기"}
        </button>
      </div>
      {blocked && (
        <p className={a.hint} style={{ color: "var(--neg)" }}>
          {blocked.error}
          {blocked.hint ? ` ${blocked.hint}` : ""}
        </p>
      )}
    </>
  );
}
