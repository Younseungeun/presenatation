"use client";

import { useState } from "react";
import type { PayoutAccountView } from "@/server/payoutAccountView";
import styles from "./payout.module.css";

// 정산 계좌 등록·변경 — **본인 인증을 같은 화면에서 다시 받는다.**
//
// 평소 로그인은 생체로 끝나지만 여기만 다르다. 생체는 "같은 기기"를 증명할 뿐
// **이름을 모르고**, 은행이 돌려주는 예금주명과 맞춰볼 상대편이 없기 때문이다.
//
// **예금주 이름 입력란은 없다.** 통신사가 준 이름과 은행이 준 이름을 우리가 맞추는
// 것이지, 본인이 적은 이름을 쓰는 것이 아니다 — 적게 하면 양쪽을 다 본인이 쓰는 것이라
// 대조가 성립하지 않는다. 그 사실을 화면에도 적어 둔다(사용자가 "왜 이름을 안 묻지"
// 하고 의심하지 않게).

/** 자주 쓰는 은행만 먼저 — 전체 목록은 실제 이체 연동 때 코드표로 대체한다 */
const BANKS = [
  { code: "004", name: "국민은행" },
  { code: "088", name: "신한은행" },
  { code: "020", name: "우리은행" },
  { code: "081", name: "하나은행" },
  { code: "011", name: "농협은행" },
  { code: "090", name: "카카오뱅크" },
  { code: "092", name: "토스뱅크" },
  { code: "089", name: "케이뱅크" },
  { code: "003", name: "기업은행" },
  { code: "023", name: "SC제일은행" },
];

export function AccountForm({
  view,
  onDone,
}: {
  view: PayoutAccountView;
  onDone: (next: PayoutAccountView) => void;
}) {
  const [open, setOpen] = useState(false);
  const [bankCode, setBankCode] = useState(BANKS[0].code);
  const [accountNumber, setAccountNumber] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/payout/account/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankCode, accountNumber, name, phone }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? "등록에 실패했습니다");
      setOpen(false);
      setAccountNumber("");
      setName("");
      setPhone("");
      onDone(body as PayoutAccountView);
    } catch (e) {
      setError(e instanceof Error ? e.message : "등록에 실패했습니다");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={styles.addAccount} onClick={() => setOpen(true)}>
        {view.registered ? "정산 계좌 변경하기" : "정산 계좌 등록하기"}
      </button>
    );
  }

  const ready = accountNumber.replace(/\D/g, "").length >= 8 && name.trim() && phone.trim();

  return (
    <div className={styles.formBox}>
      {/* 사기 경고를 **맨 위에** 둔다. 기술 관문을 전부 통과하는 유일한 공격이
          "본인이 속아서 직접 바꾸는 것"이고, 그건 이 문장으로만 막는다 */}
      <div className={styles.scamWarning}>
        <strong>누가 요청해서 계좌를 바꾸시는 거라면 그건 사기입니다.</strong>
        <br />
        INTOVILL은 어떤 경우에도 계좌 변경을 먼저 요청하지 않습니다.
      </div>

      <label className={styles.field}>
        은행
        <select
          className={styles.input}
          value={bankCode}
          onChange={(e) => setBankCode(e.target.value)}
        >
          {BANKS.map((b) => (
            <option key={b.code} value={b.code}>
              {b.name}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        계좌번호
        <input
          className={styles.input}
          value={accountNumber}
          onChange={(e) => setAccountNumber(e.target.value)}
          inputMode="numeric"
          maxLength={30}
          placeholder="'-' 없이 숫자만"
        />
      </label>

      <div className={styles.stepDivider}>
        <span>본인 확인</span>
      </div>
      <p className={styles.fieldNote}>
        계좌를 바꿀 때는 <strong>지문·얼굴만으로는 부족합니다.</strong> 통신사가 확인한
        이름과 은행이 알려준 예금주 이름이 같아야 지급되기 때문입니다.
      </p>

      <label className={styles.field}>
        이름
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
          placeholder="본인 인증에 쓰는 이름"
        />
      </label>

      <label className={styles.field}>
        휴대폰 번호
        <input
          className={styles.input}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="numeric"
          maxLength={20}
          placeholder="010-1234-5678"
        />
      </label>

      <p className={styles.fieldNote}>
        등록하면 <strong>48시간 뒤부터</strong> 새 계좌로 지급됩니다. 그 사이 본인이
        바꾼 것이 아니라면 이 화면에서 정산을 동결할 수 있습니다.
      </p>

      <div className={styles.formActions}>
        <button
          type="button"
          className={styles.addAccount}
          onClick={submit}
          disabled={busy || !ready}
        >
          {busy ? "확인하는 중…" : "본인 인증하고 등록"}
        </button>
        <button
          type="button"
          className={styles.cancelButton}
          onClick={() => setOpen(false)}
          disabled={busy}
        >
          취소
        </button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </div>
  );
}
