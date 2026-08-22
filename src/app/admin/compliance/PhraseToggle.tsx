"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import a from "../admin.module.css";

// 운영자 사전 항목의 활성/비활성. 삭제하지 않는 이유: 같은 위반이 다시 확인되면
// 되살려야 하고, 어떤 표현이 왜 꺼졌는지가 사전의 이력 자체이기 때문.
//
// **꺼진 이유가 둘이라 되살리는 뜻도 둘이다** (회신 5호 Q3):
//   비활성 → 다시 활성화  = 오탐이라 꺼 뒀던 것을 되돌린다
//   졸업   → 다시 활성화  = IRIS에게 넘겼던 것을 되찾아 온다 (회귀 문항은 그대로 남아
//                          IRIS도 계속 시험받는다 — 이중 방어가 된다)
// 같은 버튼에 같은 글자를 쓰면 두 번째 뜻이 화면에서 사라진다.

export function PhraseToggle({
  phraseId,
  active,
  graduated = false,
}: {
  phraseId: string;
  active: boolean;
  graduated?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    setBusy(true);
    try {
      await fetch("/api/admin/compliance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "SET_PHRASE_ACTIVE", phraseId, active: !active }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={a.btnrow}>
      <button type="button" className={`${a.btn} ${a.btnLine}`} onClick={toggle} disabled={busy}>
        {busy
          ? "처리 중…"
          : active
            ? "비활성화 (작성 화면에서 숨김)"
            : graduated
              ? "사전으로 되찾기 — 사전이 다시 잡습니다"
              : "다시 활성화"}
      </button>
    </div>
  );
}
