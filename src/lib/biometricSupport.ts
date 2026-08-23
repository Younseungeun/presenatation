"use client";

import { useEffect, useState } from "react";

// 이 기기에 **지문·얼굴 장치가 실제로 있는가** (2026-08-17 발견 — 안내가 막다른 길이었다).
//
// 처음에는 `!!window.PublicKeyCredential`로만 봤다. 그건 "브라우저가 이 기능을 안다"일
// 뿐 **"이 컴퓨터에 지문·얼굴 장치가 달렸다"가 아니다.** 그래서 지문 장치가 없는
// 데스크톱에서 관리자로 처음 들어오면, 화면은 "이 기기의 지문을 등록하세요"만 띄우는데
// 그 기기에서는 등록할 방법이 없었다 — 안내가 가리키는 곳이 막다른 길이었다.
//
// `isUserVerifyingPlatformAuthenticatorAvailable()`은 그 질문에 정확히 답한다.
// 다만 **비동기라 첫 렌더에서는 모른다.** 모르는 동안을 `false`로 두면 지문이 되는
// 기기에서도 잠깐 "안 됩니다" 안내가 번쩍이므로, 세 번째 상태(null = 아직 모름)를 둔다.
//
// ⚠ 이 값으로 **막지 않는다.** 플랫폼 인증기가 없어도 USB 보안키로는 등록할 수 있어서,
// 버튼을 잠그면 실제로 가능한 사람을 막게 된다. 안내만 바꾸고 시도는 늘 열어 둔다.

export type BiometricSupport = boolean | null;

export function usePlatformBiometric(): BiometricSupport {
  const [available, setAvailable] = useState<BiometricSupport>(null);

  useEffect(() => {
    let alive = true;
    const pkc = window.PublicKeyCredential;
    // 옛 브라우저에는 이 물음 자체가 없다 — 그때도 답은 비동기로 흘려보낸다
    // (효과 본문에서 곧바로 상태를 바꾸면 렌더가 한 번 더 돈다)
    const probe = pkc?.isUserVerifyingPlatformAuthenticatorAvailable
      ? pkc.isUserVerifyingPlatformAuthenticatorAvailable()
      : Promise.resolve(false);
    probe
      .then((ok) => {
        if (alive) setAvailable(ok);
      })
      // 브라우저가 답을 못 주면 "없다"로 단정하지 않는다 — 시도는 해볼 수 있다
      .catch(() => {
        if (alive) setAvailable(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  return available;
}
