"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { JUDGMENT_POPUP_DISMISS_KEY } from "../ActiveJudgmentPopup";
import styles from "../researcher/researcher.module.css";
import s from "./login.module.css";

/**
 * 본인 인증 폼 (스텁). 실서비스에서는 PASS/NICE 본인확인 창으로 대체된다.
 * 같은 휴대폰 번호는 항상 같은 계정으로 매핑된다 (1인 1계정).
 *
 * 시작 갈래는 두 가지 — 리포트를 사는 이용자 / 리포트를 파는 리서처.
 * 리서처를 고르면 계정 생성과 동시에 리서처 프로필이 만들어지고 이용계약 동의를 받는다.
 * 나중에 마음이 바뀌어도 MY에서 전환할 수 있으므로 되돌릴 수 없는 선택이 아니다.
 */
type AccountType = "USER" | "RESEARCHER";

const CHOICES: { key: AccountType; label: string; desc: string }[] = [
  { key: "USER", label: "리포트를 삽니다", desc: "예측 카드를 구매하고 판정 결과를 받아봅니다" },
  {
    key: "RESEARCHER",
    label: "리포트를 씁니다",
    desc: "예측 카드를 붙여 리포트를 판매하고 트랙레코드를 쌓습니다",
  },
];

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") ?? "/";
  const [busy, setBusy] = useState(false);
  const [accountType, setAccountType] = useState<AccountType>("USER");
  const [agreed, setAgreed] = useState(false);
  const [agreedResearcher, setAgreedResearcher] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asResearcher = accountType === "RESEARCHER";
  const canSubmit = agreed && (!asResearcher || agreedResearcher);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!agreed) {
      setError("이용약관·개인정보처리방침에 동의해야 시작할 수 있습니다.");
      return;
    }
    if (asResearcher && !agreedResearcher) {
      setError("리서처로 시작하려면 리서처 이용계약에 동의해야 합니다.");
      return;
    }
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: f.get("name"),
          phone: f.get("phone"),
          penName: f.get("penName") || undefined,
          agreedTerms: agreed,
          accountType,
          agreedResearcher: asResearcher ? agreedResearcher : undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? "인증 실패");
        return;
      }
      // 새로 로그인했으면 검증 현황을 다시 알린다 (이전 방문에서 닫았더라도)
      sessionStorage.removeItem(JUDGMENT_POPUP_DISMISS_KEY);
      // 리서처로 시작했으면 첫 화면은 리포트를 쓰는 자리로
      router.push(body.researcherId ? `/researcher/${body.researcherId}` : next);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label className={styles.label}>어떻게 시작할까요?</label>
        <div className={s.choices}>
          {CHOICES.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setAccountType(c.key)}
              aria-pressed={accountType === c.key}
              className={`${s.choice} ${accountType === c.key ? s.choiceOn : ""}`}
            >
              <span className={s.choiceLabel}>{c.label}</span>
              <span className={s.choiceDesc}>{c.desc}</span>
            </button>
          ))}
        </div>
        <span className={styles.hint}>나중에 MY에서 언제든 바꿀 수 있어요.</span>
      </div>

      <div className={styles.field}>
        <label className={styles.label}>이름</label>
        <input className={styles.input} name="name" required placeholder="홍길동" />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>휴대폰 번호</label>
        <input
          className={styles.input}
          name="phone"
          required
          inputMode="numeric"
          placeholder="010-1234-5678"
        />
        <span className={styles.hint}>같은 번호는 항상 같은 계정으로 연결됩니다 (1인 1계정).</span>
      </div>
      <div className={styles.field}>
        <label className={styles.label}>필명 {asResearcher ? "" : "(선택)"}</label>
        <input className={styles.input} name="penName" placeholder="공개 활동명" maxLength={30} />
        <span className={styles.hint}>
          {asResearcher
            ? "리포트에 표시될 이름입니다. 설정에서 나중에 바꿀 수 있어요."
            : "실명 대신 표시될 이름입니다. 설정에서 나중에 정해도 됩니다."}
        </span>
      </div>

      <label className={styles.consent}>
        <input
          type="checkbox"
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
        />
        <span>
          <Link href="/terms/TERMS_OF_SERVICE" target="_blank">
            이용약관
          </Link>
          {" 및 "}
          <Link href="/terms/PRIVACY_POLICY" target="_blank">
            개인정보처리방침
          </Link>
          에 동의합니다 (필수)
        </span>
      </label>

      {asResearcher && (
        <label className={styles.consent}>
          <input
            type="checkbox"
            checked={agreedResearcher}
            onChange={(e) => setAgreedResearcher(e.target.checked)}
          />
          <span>
            <Link href="/terms/RESEARCHER_AGREEMENT" target="_blank">
              리서처 이용계약
            </Link>
            에 동의합니다 (필수) — 게시한 예측 카드는 수정·삭제할 수 없고 판정 결과가
            공개됩니다
          </span>
        </label>
      )}

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.formActions}>
        <button className={styles.primaryBtn} type="submit" disabled={busy || !canSubmit}>
          {busy ? "인증 중…" : asResearcher ? "본인 인증하고 리서처로 시작" : "본인 인증하고 시작"}
        </button>
      </div>
    </form>
  );
}
