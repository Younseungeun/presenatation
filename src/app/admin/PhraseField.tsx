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
  /**
   * 이 표현을 켜면 **지금 팔리는 글** 몇 건이 걸리는가 (창업자 지시).
   * 등록 후에도 같은 숫자가 나오지만 그때는 이미 사전에 올라간 뒤라 늦다.
   * 이미 켜져 있는 항목이거나 형태가 틀렸으면 재지 않아 null 이다.
   */
  rescan: { scanned: number; hits: number } | null;
}

/**
 * 여기부터 "넓다" 고 본다.
 *
 * @근거 설계 — 창업자 지시의 예시값(*"20건이 걸리면 그 표현은 너무 넓은 것"*).
 *   실측으로 유도한 값이 아니라 **말을 그대로 옮긴 것**이라, 운영 데이터가 쌓이면
 *   등록된 표현의 실제 정확도(matchCount 대비 confirmedCount)로 다시 잡아야 한다.
 *   지금 이 값이 하는 일은 차단이 아니라 **눈에 띄게 하기**뿐이다 — 넘어도 등록은 된다.
 */
const BROAD_HIT_COUNT = 20;

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
      {/* **무엇을 더하는 것인지**를 적는다 — 별개 검사기를 만드는 것이 아니라
          코드 규칙이 잡을 표현을 더하는 것이다(같은 배열·같은 층·같은 가드).
          그리고 **어디까지인지**도 함께 적는다: 사전 항목은 언제나 보류까지고,
          즉시 거절은 코드 배포로만 생긴다(회신 7호 §2·§3 확정). 이 두 줄이 없으면
          운영자가 "정확도가 쌓이면 저절로 세진다"고 기대하게 된다 */}
      <p className={a.hint}>
        등록한 표현은 사전에 올라가 <b>다음 리서처가 글을 쓰는 중에</b> 같은 표현에서
        경고를 띄웁니다 — 검수 범위가 운영 중에 넓어지는 유일한 통로입니다. 종목명·숫자를
        뺀 재사용 가능한 형태로 줄여 주세요. 위에서 고른 유형 중 첫 번째로 등록됩니다.
        <br />
        <b>이 표현은 보류까지입니다</b> — 아무리 정확해져도 저절로 즉시 거절이 되지는
        않습니다. 즉시 거절은 문맥 조건을 코드로 적어 배포할 때만 생깁니다.
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
      <>
        <p className={a.hint} style={{ color: "#b45309" }}>
          꺼 둔 항목이 있습니다 (<b>{RISK_CATEGORY_LABEL[off.category]}</b>) — 등록하면{" "}
          <b>다시 켜집니다.</b> 같은 위반이 다시 확인된 것이라면 맞는 동작입니다.
        </p>
        <RescanLine rescan={preview.rescan} />
      </>
    );
  }

  return (
    <>
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
      <RescanLine rescan={preview.rescan} />
    </>
  );
}

/**
 * **누르기 전에 답한다** — 이 표현을 켜면 지금 팔리는 글 몇 건이 걸리는가.
 *
 * 등록 후에도 같은 숫자가 나오지만 그때는 이미 사전에 올라간 뒤라, 끄는 절차를 따로
 * 밟는 동안 작성 화면은 그 표현으로 경고를 띄운다. 되돌릴 수 있는 유일한 순간이 여기다.
 *
 * ── 세 가지를 함께 적는다 ─────────────────────────────────────────────
 * ① **분모** — 3건이 많은지 적은지는 전체를 알아야 정해진다
 * ② **0건이어도 침묵하지 않는다** — 침묵은 "안 쟀다"와 구별되지 않는다. 그리고 0건은
 *    나쁜 소식이 아니다(앞으로 올 글에는 그대로 닿는다)는 사실을 같이 적어야
 *    운영자가 표현을 억지로 넓히지 않는다
 * ③ **처분이 아니다** — 걸린 글은 목록에 오를 뿐 게시는 그대로다. 이 줄을 읽고
 *    "20건이 내려간다"고 오해하면 등록 자체를 피하게 된다
 *
 * 못 잰 경우(null)에는 아무것도 그리지 않는다 — 미리보기 부재는 사건이 아니고,
 * 등록 직후 사진이 같은 계산을 다시 한다.
 */
function RescanLine({ rescan }: { rescan: Preview["rescan"] }) {
  if (!rescan) return null;
  const broad = rescan.hits >= BROAD_HIT_COUNT;
  return (
    <p
      className={a.hint}
      style={{
        color: broad ? "#b45309" : "var(--text-weak)",
        fontWeight: broad ? 600 : 400,
      }}
    >
      지금 팔리는 글 <b>{rescan.scanned}건</b> 중 <b>{rescan.hits}건</b>이 이 표현에
      걸립니다.
      {rescan.hits === 0 ? (
        <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
          {" "}
          지금 걸리는 글은 없지만 <b>앞으로 올라올 글에는 그대로 닿습니다</b> — 건수를
          늘리려고 표현을 넓힐 이유는 없습니다.
        </span>
      ) : (
        <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>
          {" "}
          {broad && (
            <>
              <b>표현이 너무 넓지 않은지 확인해 주세요.</b>{" "}
            </>
          )}
          걸린 글은 <b>목록에 오를 뿐 게시는 그대로입니다</b> — 내릴지는 운영자가 따로
          정합니다.
        </span>
      )}
    </p>
  );
}
