"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RISK_CATEGORY_LABEL, type RiskCategory } from "@/domain/compliance";
import { PHRASE_MAX_LENGTH } from "@/domain/learnedPhrases";
import a from "./admin.module.css";

/**
 * 사전 등록란 — **반려 폼과 신고 처리 폼이 같은 것을 쓴다.**
 *
 * 전에는 두 화면이 각자 `<input>` 을 갖고 있었고, 어느 쪽에도 검증이 없었다.
 * 등록이 실패해도 **반려·철회는 그대로 성공**하므로(registerPhrase 는 사유 문자열만
 * 돌려준다) 운영자는 다 됐다고 생각하는데 되먹임의 빠른 길만 조용히 끊긴다.
 *
 * 특히 **두 어절 하한**이 눈에 안 보인다: "있습니다" 는 네 글자라 길이 규칙은
 * 통과하는데, 등록되면 정상 리포트를 무더기로 잡아 사전이 전면 차단기가 된다.
 * 기본값(suggestPhrase)은 이미 이 검사를 통과한 것만 고르므로 안전하지만,
 * **운영자가 손대는 순간부터 아무도 안 본다.** 그 자리를 여기서 메운다.
 *
 * 검사는 서버에서 돈다 (`/api/admin/compliance/phrase-preview`) — 정규화기를
 * 브라우저에 실으면 회피 탐지의 처리 순서가 공개되고, 중복 검사에는 사전이 필요하다.
 */

interface Preview {
  issues: string[];
  needsCategory: boolean;
  matches: { id: string; phrase: string; category: RiskCategory; active: boolean }[];
  /**
   * 근사 표기까지 감시받는가 — **여부만 온다.** 무엇과 부딪혔는지는 응답에 없다
   * (확인서 Q1 → 회신 5호 (가)): 충돌 상대를 알면 그것을 피해 표현을 다듬게 되고,
   * 그건 대조 표본에 사전을 최적화하는 일이라 오탐률 측정이 오염된다.
   * 충돌 목록은 **등록 직후 한 번** 따로 보여준다.
   */
  phoneticEligible: boolean | null;
}

/** 타이핑 중에는 답하지 않는다 — 한 글자마다 붉은 줄이 뜨면 쓰는 것을 방해한다 */
const DEBOUNCE_MS = 500;

export function PhraseField({
  value,
  onChange,
  category,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  /** 등록될 유형 (운영자가 고른 것 중 첫 번째) — 없으면 서버가 등록을 거절한다 */
  category?: RiskCategory;
  placeholder: string;
}) {
  const [preview, setPreview] = useState<(Preview & { key: string }) | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 입력과 유형이 함께 답을 정한다 — 유형만 바뀌어도 "등록됩니다"가 뒤집힌다.
  // **`?? null` 을 쓰면 안 된다**: 이 문자열이 그대로 요청 본문이 되는데 스키마의
  // `category` 는 optional 이라 null 을 거절한다(첫 판이 400 을 받았다).
  // undefined 는 JSON.stringify 가 키째로 빼므로 "안 골랐다"가 그대로 전달된다
  const key = JSON.stringify({ phrase: value.trim(), category });

  const ask = useCallback(async (body: string): Promise<Preview | null> => {
    try {
      const res = await fetch("/api/admin/compliance/phrase-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      return res.ok ? ((await res.json()) as Preview) : null;
    } catch {
      // 미리보기를 못 받는 것은 사건이 아니다 — 제출하면 서버가 다시 본다
      return null;
    }
  }, []);

  useEffect(() => {
    if (!value.trim()) return;
    if (timer.current) clearTimeout(timer.current);
    let alive = true;
    timer.current = setTimeout(() => {
      void (async () => {
        const next = await ask(key);
        if (alive && next) setPreview({ ...next, key });
      })();
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [key, value, ask]);

  // 지금 입력에 대한 답이 아직 없으면 옛 답을 그리지 않는다 — 옛 답은 거짓말이다
  const fresh = preview?.key === key ? preview : null;

  return (
    <div className={a.field}>
      <input
        className={a.input}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={PHRASE_MAX_LENGTH * 3}
        placeholder={placeholder}
      />
      {fresh && <PhraseVerdict preview={fresh} />}
      <p className={a.hint}>
        등록한 표현은 사전에 올라가 <b>다음 리서처가 글을 쓰는 중에</b> 같은 표현에서
        경고를 띄웁니다 — 검수 범위가 운영 중에 넓어지는 유일한 통로입니다. 종목명·숫자를
        뺀 재사용 가능한 형태로 줄여 주세요. 위에서 고른 유형 중 첫 번째로 등록됩니다.
      </p>
    </div>
  );
}

/**
 * 한 번에 **한 가지만** 말한다. 형태가 틀렸으면 중복은 의미가 없고(어차피 등록이
 * 안 된다), 유형이 없으면 표현이 맞았는지는 부차적이다 — 여러 줄을 한꺼번에 띄우면
 * 무엇부터 고쳐야 할지가 흐려진다.
 */
function PhraseVerdict({ preview }: { preview: Preview }) {
  if (preview.issues.length > 0) {
    return (
      <p className={a.hint} style={{ color: "var(--neg)", fontWeight: 600 }}>
        {preview.issues.join(" / ")}
        <br />
        <span style={{ fontWeight: 400 }}>
          이대로 두면 반려는 처리되지만 <b>사전에는 아무것도 남지 않습니다.</b>
        </span>
      </p>
    );
  }

  if (preview.needsCategory) {
    return (
      <p className={a.hint} style={{ color: "#b45309", fontWeight: 600 }}>
        위반 유형을 하나 이상 골라야 이 표현이 등록됩니다 — 유형 없이는 사전에 아무것도
        남지 않습니다.
      </p>
    );
  }

  // 정규화가 같은 항목 — 유형이 같으면 새로 안 생기고, 다르면 별개 항목이 된다.
  // 둘 다 운영자가 알아야 하는 사실이라 침묵하지 않는다
  const same = preview.matches.find((m) => m.active);
  const off = preview.matches.find((m) => !m.active);
  if (same) {
    return (
      <p className={a.hint} style={{ color: "var(--text-weak)" }}>
        이미 사전에 있습니다 (<b>{RISK_CATEGORY_LABEL[same.category]}</b>) — 새로 등록되지
        않고 기존 항목이 그대로 쓰입니다.
      </p>
    );
  }
  if (off) {
    return (
      <p className={a.hint} style={{ color: "#b45309" }}>
        꺼 둔 항목이 있습니다 (<b>{RISK_CATEGORY_LABEL[off.category]}</b>) — 등록하면{" "}
        <b>다시 켜집니다.</b> 같은 위반이 다시 확인된 것이라면 맞는 동작입니다.
      </p>
    );
  }

  return (
    <p className={a.hint} style={{ color: "var(--text-faint)" }}>
      ✓ 새 항목으로 등록됩니다.
      {/* **자격은 여부만 말한다.** 무엇과 부딪혔는지는 응답에 없고, 그것이 이 문구의
          설계다 — 상대를 알면 그것을 피해 표현을 다듬게 되고 대조 표본에 최적화된다.
          자격이 없어도 손실은 작다(정확 표기 감시는 그대로)는 사실을 함께 적어,
          운영자가 표현을 억지로 바꾸려 들지 않게 한다 */}
      {preview.phoneticEligible === false && (
        <>
          <br />
          근사 표기까지는 감시하지 못합니다 (정확 표기 감시는 됩니다).
        </>
      )}
    </p>
  );
}
