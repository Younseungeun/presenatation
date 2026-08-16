"use client";

import { useState, useSyncExternalStore } from "react";
import { startRegistration } from "@simplewebauthn/browser";
import styles from "./devices.module.css";

type Device = {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
};

// 등록된 기기 목록 + 이 기기 등록하기.
//
// **기기 이름을 사용자가 짓게 한다.** 브라우저 User-Agent로 자동 생성하면 "Chrome 141"
// 같은 것이 나오는데, 폰과 노트북에서 같은 크롬을 쓰면 둘을 구별하지 못한다.
// 어느 기기를 지울지 고르는 것이 이 목록의 존재 이유라, 구별되지 않으면 쓸모가 없다.

// 서버에서는 항상 false로 그린다 — useEffect로 setState하면 화면이 번쩍인다
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

export function DeviceManager({ initial }: { initial: Device[] }) {
  const [devices, setDevices] = useState(initial);
  const supported = usePasskeySupported();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/passkey/devices");
    if (res.ok) setDevices(await res.json());
  }

  async function register() {
    setBusy(true);
    setError(null);
    try {
      const optionsRes = await fetch("/api/passkey/register");
      const optionsJSON = await optionsRes.json();
      if (!optionsRes.ok) throw new Error(optionsJSON?.error ?? "등록을 시작할 수 없습니다");

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
      // 이미 등록된 기기에서 또 등록하면 인증기가 스스로 막는다 — 그대로 말해준다
      if (name === "InvalidStateError") {
        setError("이 기기는 이미 등록되어 있습니다.");
        return;
      }
      setError(e instanceof Error ? e.message : "등록에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    const res = await fetch("/api/passkey/devices", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passkeyId: id }),
    });
    if (!res.ok) {
      setError("기기를 지우지 못했습니다");
      return;
    }
    await refresh();
  }

  return (
    <>
      <div className={styles.list}>
        {devices.length === 0 ? (
          <p className={styles.empty}>
            등록된 기기가 없습니다. 지금 쓰는 기기를 등록하면 다음부터 지문·얼굴로 바로
            로그인합니다.
          </p>
        ) : (
          devices.map((d) => (
            <div key={d.id} className={styles.row}>
              <div>
                <div className={styles.name}>{d.label}</div>
                <div className={styles.sub}>마지막 사용 {fmt(d.lastUsedAt)}</div>
              </div>
              <button type="button" className={styles.remove} onClick={() => remove(d.id)}>
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
            {busy ? "등록하는 중…" : "이 기기 등록하기"}
          </button>
        </div>
      ) : (
        <p className={styles.empty}>이 브라우저는 지문·얼굴 로그인을 지원하지 않습니다.</p>
      )}
      {error && <p className={styles.error}>{error}</p>}
    </>
  );
}
