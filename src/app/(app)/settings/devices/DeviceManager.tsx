"use client";

import { useState, useSyncExternalStore } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import type { LoginDevice } from "@/server/deviceService";
import styles from "./devices.module.css";

// 로그인 기기 — **생체와 간편 비밀번호를 한 목록으로 본다.**
//
// 나눠서 보여 주면 잃어버린 폰을 지우려는 사람이 **한쪽만 지우고 안심**한다.
// 그게 이 화면에서 가장 비싼 실수라, 종류는 배지로만 구분하고 목록은 하나로 둔다.
//
// **기기 이름은 사용자가 짓는다.** User-Agent로 자동 생성하면 "Chrome 141"이 나오는데,
// 폰과 노트북에서 같은 크롬을 쓰면 둘을 구별하지 못한다 — 어느 기기를 지울지 고르는
// 것이 이 목록의 존재 이유라, 구별되지 않으면 쓸모가 없다.

const NO_SUBSCRIBE = () => () => {};
const usePasskeySupported = () =>
  useSyncExternalStore(
    NO_SUBSCRIBE,
    () => !!window.PublicKeyCredential,
    () => false,
  );

function fmt(iso: string | null) {
  if (!iso) return "아직 사용 안 함";
  return new Date(iso).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" });
}

export function DeviceManager({ initial }: { initial: LoginDevice[] }) {
  const [devices, setDevices] = useState(initial);
  const supported = usePasskeySupported();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReverify, setNeedsReverify] = useState(false);

  async function refresh() {
    const res = await fetch("/api/passkey/devices");
    if (res.ok) setDevices(await res.json());
  }

  async function register() {
    setBusy(true);
    setError(null);
    setNeedsReverify(false);
    try {
      const optionsRes = await fetch("/api/passkey/register");
      const optionsJSON = await optionsRes.json();
      if (!optionsRes.ok) {
        // 관문에 걸린 것은 **두 종류를 나눠서** 다룬다. 재인증으로 지금 풀리는 것과,
        // 기다려야만 풀리는 것 — 뭉뚱그리면 "다시 시도"가 영영 안 되는 화면이 되거나,
        // 기다려야 하는 사람에게 헛된 인증을 시키게 된다
        if (optionsJSON?.code === "REVERIFY_REQUIRED") setNeedsReverify(true);
        throw new Error(optionsJSON?.error ?? "등록을 시작할 수 없습니다");
      }

      const response = await startRegistration({ optionsJSON });
      const res = await fetch("/api/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response, label: label.trim() || "내 기기" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "등록에 실패했습니다");
      setLabel("");
      await refresh();
    } catch (e) {
      const name = (e as { name?: string })?.name;
      // 지문 창을 그냥 닫은 것은 오류가 아니다
      if (name === "NotAllowedError" || name === "AbortError") return;
      if (name === "InvalidStateError") {
        setError("이 기기는 이미 등록되어 있습니다.");
        return;
      }
      setError(e instanceof Error ? e.message : "등록에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function remove(device: LoginDevice) {
    setError(null);
    const res = await fetch("/api/passkey/devices", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: device.id, kind: device.kind }),
    });
    if (!res.ok) {
      setError("기기를 지우지 못했습니다");
      return;
    }
    // 삭제는 **모든 세션을 끊는다** — 지금 이 창도 포함이다. 로그인 화면으로 보내
    // "지웠는데 왜 계속 들어와 있지"라는 혼란을 없앤다
    window.location.assign("/login");
  }

  return (
    <>
      <div className={styles.list}>
        {devices.length === 0 ? (
          <p className={styles.empty}>
            등록된 기기가 없습니다. 지금 쓰는 기기를 등록하면 다음부터 바로 로그인합니다.
          </p>
        ) : (
          devices.map((d) => (
            <div key={`${d.kind}-${d.id}`} className={styles.row}>
              <div>
                <div className={styles.name}>
                  {d.label}
                  <span className={styles.badge}>
                    {d.kind === "BIOMETRIC" ? "지문·얼굴" : "간편 비밀번호"}
                  </span>
                  {d.locked && <span className={styles.lockedBadge}>잠김</span>}
                </div>
                <div className={styles.sub}>마지막 사용 {fmt(d.lastUsedAt)}</div>
              </div>
              <button type="button" className={styles.remove} onClick={() => remove(d)}>
                삭제
              </button>
            </div>
          ))
        )}
      </div>

      {supported ? (
        <div className={styles.addBox}>
          <label className={styles.addLabel}>
            이 기기를 뭐라고 부를까요?
            <input
              className={styles.input}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={40}
              placeholder="예: 내 아이폰"
            />
          </label>
          <button type="button" className={styles.add} onClick={register} disabled={busy}>
            {busy ? "등록하는 중…" : "이 기기에 지문·얼굴 등록"}
          </button>
        </div>
      ) : (
        <p className={styles.empty}>이 브라우저는 지문·얼굴 로그인을 지원하지 않습니다.</p>
      )}
      {error && <p className={styles.error}>{error}</p>}
      {/* 막다른 길로 두지 않는다 — 재인증으로 풀리는 경우에는 그 길을 바로 보여준다 */}
      {needsReverify && (
        <p className={styles.empty}>
          <a href="/login?next=/settings/devices">본인 인증 다시 하기 →</a>
        </p>
      )}
    </>
  );
}
