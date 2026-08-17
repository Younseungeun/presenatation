"use client";

import { startAuthentication } from "@simplewebauthn/browser";

// 운영자 생체 재확인 (2026-08-17 — 1인 운영 모드).
//
// 서버가 RECHECK_REQUIRED를 돌려주면 화면이 이 함수를 부른다: 지문·얼굴 창을 띄우고,
// 서명을 서버에 보내 **1회용 표**를 받아 돌려준다 — 화면은 그 표를 실어 원래 요청을
// 한 번 더 보낸다.
//
// **표를 쓰는 이유**(2026-08-17 자체 발견 결함 수정): 재확인을 사용자 단위로만 찍으면
// 훔친 세션이 창업자의 재확인에 얹혀 간다 — 다른 기기에서 세션을 쥐고 기다리다가
// 창업자가 지문을 대는 순간 같이 통과하는 것이다. 표는 생체를 통과한 이 화면의
// 응답으로만 나오므로, 세션만 있는 쪽은 손에 넣을 수 없다.

export async function performOperatorRecheck(): Promise<{
  ok: boolean;
  token?: string;
  error?: string;
}> {
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
    const body = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok) {
      return { ok: false, error: body?.error ?? "생체 확인에 실패했습니다" };
    }
    return { ok: true, token: body.token };
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
