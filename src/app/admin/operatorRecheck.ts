"use client";

import { startAuthentication } from "@simplewebauthn/browser";

// 운영자 생체 재확인 (2026-08-17 — 1인 운영 모드).
//
// 서버가 RECHECK_REQUIRED를 돌려주면 화면이 이 함수를 부른다: 지문·얼굴 창을 띄우고,
// 서명을 서버에 보내 재확인 도장을 받은 뒤 true를 돌려준다 — 화면은 원래 요청을
// 한 번 더 보내면 된다. 재확인은 1회용이라(서버가 쓰면서 지운다) 실행마다 다시 찍는다.

export async function performOperatorRecheck(): Promise<{ ok: boolean; error?: string }> {
  try {
    const optionsRes = await fetch("/api/passkey/recheck");
    if (!optionsRes.ok) {
      return { ok: false, error: "지금은 생체 확인을 쓸 수 없습니다" };
    }
    const response = await startAuthentication({ optionsJSON: await optionsRes.json() });
    const verifyRes = await fetch("/api/passkey/recheck", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    });
    if (!verifyRes.ok) {
      const body = await verifyRes.json().catch(() => ({}));
      return { ok: false, error: body?.error ?? "생체 확인에 실패했습니다" };
    }
    return { ok: true };
  } catch (e) {
    // 사용자가 지문 창을 그냥 닫은 것은 오류가 아니다 — 조용히 취소로 처리한다
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "AbortError") {
      return { ok: false };
    }
    return {
      ok: false,
      error:
        "이 기기에서는 생체 확인을 할 수 없습니다 — 지문·얼굴이 등록된 기기에서 실행해주세요.",
    };
  }
}
