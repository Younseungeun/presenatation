"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { PEN_NAME_MAX, PEN_NAME_MIN } from "@/domain/penName";
import { clearFloatingDismissals } from "../floatingDismiss";
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

/**
 * mode — "signup"(기본) = 가입 겸 로그인. "reset" = 간편 비밀번호 재설정을 위한 본인 인증만.
 * reset 은 이미 계정이 있는 사람이 들어오는 길이라 가입용 UI(가입 갈래·필명·리서처 동의)를
 * 숨기고 휴대폰 본인 인증만 받는다. 인증 성공 후 next(=/settings/pin)에서 새 비밀번호를 정한다.
 *
 * ⚠ 통신사 본인 인증(PASS/NICE) 연동 자리 — 지금은 휴대폰 번호 스텁이 그 역할을 대신한다.
 *    실공급자가 붙으면 이 폼 대신 통신사 인증 창을 띄우고, 반환된 이름·번호·CI로 곧장
 *    /api/auth/verify 를 호출하면 된다(그때 이름·번호 입력란은 사라진다).
 */
export function LoginForm({ mode = "signup" }: { mode?: "signup" | "reset" } = {}) {
  const router = useRouter();
  const search = useSearchParams();
  const next = search.get("next") ?? "/";
  const isReset = mode === "reset";
  const [busy, setBusy] = useState(false);
  const [accountType, setAccountType] = useState<AccountType>("USER");
  // 재설정은 이미 약관에 동의한 계정이라 재동의를 받지 않는다(체크박스 숨김, 항상 동의).
  const [agreed, setAgreed] = useState(isReset);
  const [agreedResearcher, setAgreedResearcher] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const asResearcher = !isReset && accountType === "RESEARCHER";
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
      clearFloatingDismissals();
      // 관리자면 운영 대시보드, 리서처로 시작했으면 리포트를 쓰는 자리로
      const dest = body.operator
        ? "/admin"
        : body.researcherId
          ? `/researcher/${body.researcherId}`
          : next;
      // 이 기기에 간편 비밀번호가 없으면 **먼저 만들고** 목적지로 간다 — 필수라서다.
      // 지금 세션은 방금 인증한 세션이라 설정 관문(최근성)을 자연히 통과한다
      router.push(
        body.pinSetupRequired ? `/settings/pin?next=${encodeURIComponent(dest)}` : dest,
      );
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      {!isReset && (
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
      )}

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
      {/* **필명은 필수다** (2026-08-20 사용자 확정). 선택으로 두었더니 구매만 하는
          이용자는 대개 이름이 없었고, 그 사람이 나타나야 하는 화면마다(신고자·문의자·
          팔로워) 부를 이름이 없어 화면마다 다른 대체 표기를 지어냈다 —
          그중 어느 것도 본인이 자기 이름으로 알아볼 수 없는 값이었다 (domain/penName.ts).
          재설정은 이미 필명이 있는 계정이라 다시 받지 않는다. */}
      {!isReset && (
        <div className={styles.field}>
          <label className={styles.label}>필명</label>
          <input
            className={styles.input}
            name="penName"
            placeholder="공개 활동명"
            required
            minLength={PEN_NAME_MIN}
            maxLength={PEN_NAME_MAX}
          />
          <span className={styles.hint}>
            {asResearcher
              ? "리포트에 표시될 이름입니다. 설정에서 나중에 바꿀 수 있어요."
              : "앱에서 표시될 이름입니다 — 실명은 쓰지 않습니다. 설정에서 나중에 바꿀 수 있어요."}
          </span>
        </div>
      )}

      {!isReset && (
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
      )}

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
          {busy
            ? "인증 중…"
            : isReset
              ? "본인 인증하고 비밀번호 재설정"
              : asResearcher
                ? "본인 인증하고 리서처로 시작"
                : "본인 인증하고 시작"}
        </button>
      </div>
    </form>
  );
}
