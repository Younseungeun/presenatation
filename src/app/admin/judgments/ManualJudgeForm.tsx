"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { performOperatorRecheck } from "../operatorRecheck";
import a from "../admin.module.css";

// 수동 판정 폼: 카드 유형에 맞는 시세만 입력받는다.
// - RETURN_PCT: 시한 종가 (+ 소급 카드는 기준가)
// - TARGET_PRICE 상승: 기간 최고가 / 하락: 기간 최저가
// 판정 불가 처리 시에는 사유 코드를 고른다. 서술 사유는 항상 필수.
//
// **입력 실수 방어가 이 화면의 디자인 과제다** (design-backlog B) — 운영자가 넣는
// 숫자가 그대로 원천 데이터가 되고, 그 위에서 점수·정산이 계산된다.
// 시안 v3의 문법으로 세 겹을 둔다 (2026-08-19):
//   ① **갈래를 펴 둔다.** 처리 방식이 드롭다운이었는데, 그러면 "판정 불가 = 전액 환불"
//      이라는 정반대 결말이 접힌 채 숨는다. 두 길을 나란히 놓고 고른 쪽만 살린다
//   ② **되읽어 준다.** 넣은 숫자를 자릿점 찍어 크게 되돌려 보여준다 — 0을 하나 더 친
//      1,200,000은 120,000 옆에서 눈에 띄지만, 입력칸 안의 1200000은 안 띈다
//   ③ **잉크와 🔒.** 다 채우기 전에는 회색이고, 두 결말 모두 되돌릴 수 없어 자물쇠가 선다
//      (이 화면은 통째로 불가역이다 — 그래서 여기서는 자물쇠가 예외가 아니라 규칙이다)

const UNDECIDABLE_OPTIONS = [
  { value: "TRADING_HALT", label: "거래정지" },
  { value: "DELISTED", label: "상장폐지" },
  { value: "AMBIGUOUS", label: "판정 불능 (데이터 없음·조건 모호)" },
] as const;

export function ManualJudgeForm({
  cardId,
  targetType,
  direction,
  needsBasePrice,
}: {
  cardId: string;
  targetType: string;
  direction: string;
  needsBasePrice: boolean;
}) {
  const router = useRouter();
  const [mode, setMode] = useState<"PRICE" | "UNDECIDABLE" | null>(null);
  const [price, setPrice] = useState("");
  const [basePrice, setBasePrice] = useState("");
  const [undecidableReason, setUndecidableReason] = useState<string>("AMBIGUOUS");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pricing = mode === "PRICE";
  const voiding = mode === "UNDECIDABLE";
  const priceLabel =
    targetType === "RETURN_PCT" ? "시한 종가" : direction === "UP" ? "기간 최고가" : "기간 최저가";

  const priceNum = Number(price);
  const priceOk = price.trim() !== "" && Number.isFinite(priceNum) && priceNum > 0;
  const ready = mode !== null && reason.trim().length > 0 && (voiding || priceOk);
  const missing = !mode
    ? "시세로 판정할지 판정 불가로 닫을지 먼저 골라 주세요"
    : pricing && !priceOk
      ? `${priceLabel}를 넣어야 합니다 — 이 숫자가 그대로 원천 데이터가 됩니다`
      : !reason.trim()
        ? "사유를 적어야 합니다 — 감사 기록에 남는 유일한 근거입니다"
        : "";

  async function submit(recheckToken?: string) {
    if (!ready || !mode) return;
    setBusy(true);
    setError(null);
    try {
      const decision = voiding
        ? { type: "UNDECIDABLE", undecidableReason }
        : {
            type: "PRICE",
            // 판정 규칙 통합(2026-08-10): 유형과 무관하게 "기간 중 종가 극값"으로
            // 도달을 판정한다. 운영자가 값 하나를 입력하면 극값이자 시한 종가로 쓴다
            // (더 아는 것이 없을 때의 보수 기본값 — manualJudgmentService와 같은 규칙)
            ...(direction === "UP"
              ? { maxCloseSincePublish: priceNum, priceAtDeadline: priceNum }
              : { minCloseSincePublish: priceNum, priceAtDeadline: priceNum }),
            ...(needsBasePrice && basePrice ? { basePrice: Number(basePrice) } : {}),
          };
      const res = await fetch("/api/admin/judgments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cardId, reason, decision, recheckToken }),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.code === "RECHECK_REQUIRED" && !recheckToken) {
          // 1인 운영 모드 — 두 번째 사람 대신 지문·얼굴이 선다. 받은 표를 실어 한 번만 재시도
          const recheck = await performOperatorRecheck();
          if (recheck.ok && recheck.token) {
            await submit(recheck.token);
            return;
          }
          if (recheck.error) setError(recheck.error);
          return;
        }
        setError(body.error ?? "판정 실패");
        return;
      }
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={a.form}>
      {/* ── 갈래 ─────────────────────────────────────────────── */}
      <div className={a.chips}>
        <button
          type="button"
          className={`${a.pick} ${pricing ? a.pickOn : ""}`}
          onClick={() => setMode(pricing ? null : "PRICE")}
        >
          시세로 판정한다
        </button>
        <button
          type="button"
          className={`${a.pick} ${voiding ? a.pickOn : ""}`}
          onClick={() => setMode(voiding ? null : "UNDECIDABLE")}
        >
          판정 불가로 닫는다 (전액 환불)
        </button>
      </div>

      {pricing && (
        <div className={a.branch}>
          <div className={a.lbl}>
            {priceLabel}
            <small>검증된 시세 — 거래소 공시·공급자 재조회로 확인한 값</small>
          </div>
          <div className={a.field}>
            <input
              className={a.input}
              type="number"
              min="0"
              step="any"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="예: 71000"
              aria-label={priceLabel}
            />
          </div>
          {needsBasePrice && (
            <>
              <div className={a.lbl}>
                기준가 (소급 확정)
                <small>게시 시점 규칙상 기준가 — 비워 두면 기존 값을 씁니다</small>
              </div>
              <div className={a.field}>
                <input
                  className={a.input}
                  type="number"
                  min="0"
                  step="any"
                  value={basePrice}
                  onChange={(e) => setBasePrice(e.target.value)}
                  placeholder="예: 63500"
                  aria-label="기준가"
                />
              </div>
            </>
          )}
        </div>
      )}

      {voiding && (
        <div className={a.branch}>
          <div className={a.lbl}>판정 불가 사유</div>
          <div className={a.chips}>
            {UNDECIDABLE_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                className={`${a.pick} ${undecidableReason === o.value ? a.pickOn : ""}`}
                onClick={() => setUndecidableReason(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className={`${a.note} ${a.noteNeg}`}>
            판정 불가로 닫으면 <b>전액 환불 · 수수료 0 · 점수 0</b>입니다 — 표본에서도 빠집니다.
          </div>
        </div>
      )}

      <div className={a.lbl}>
        수동 판정 사유
        <small>감사 기록 — 왜 사람이 판정했는지가 여기에만 남습니다</small>
      </div>
      <div className={a.field}>
        <textarea
          className={a.textarea}
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="예: 공급자 API 결측 — 거래소 공시 종가로 확인 (URL)"
          aria-label="수동 판정 사유"
        />
      </div>

      {/* **넣은 값을 되읽어 준다** — 0 하나가 더 붙은 실수는 자릿점이 찍혀야 눈에 띈다 */}
      <div className={a.sent}>
        <div className={a.sTag}>원천 데이터로 기록될 값</div>
        <div className={`${a.sV} ${mode ? "" : a.sVNone}`}>
          {!mode
            ? "갈래를 고르면 여기 나타납니다"
            : voiding
              ? `판정 불가 — ${UNDECIDABLE_OPTIONS.find((o) => o.value === undecidableReason)?.label}`
              : priceOk
                ? `${priceLabel} ${priceNum.toLocaleString()}원`
                : "시세를 넣으면 여기 나타납니다"}
        </div>
        {pricing && needsBasePrice && basePrice.trim() !== "" && (
          <div className={a.sP}>기준가 {Number(basePrice).toLocaleString()}원</div>
        )}
        <div className={`${a.sV} ${reason.trim() ? "" : a.sVNone}`}>
          {reason.trim() || "사유를 적으면 여기 그대로 나타납니다"}
        </div>
      </div>

      <div className={a.btnrow}>
        <button
          type="button"
          className={`${a.btn} ${voiding && ready && !busy ? a.btnInk : a.btnLine} ${
            pricing ? a.blocked : ""
          }`}
          disabled={!voiding || !ready || busy}
          onClick={() => submit()}
        >
          {busy && voiding ? "처리 중…" : "판정 불가 · 전액 환불"}
          <span className={a.fp}>🔒</span>
        </button>
        <button
          type="button"
          className={`${a.btn} ${pricing && ready && !busy ? a.btnInk : a.btnLine} ${
            voiding ? a.blocked : ""
          }`}
          disabled={!pricing || !ready || busy}
          onClick={() => submit()}
        >
          {busy && pricing ? "판정 중…" : "판정 실행"}
          <span className={a.fp}>🔒</span>
        </button>
      </div>

      {missing && <div className={a.gate}>{missing}</div>}
      {error && <p className={a.error}>{error}</p>}
    </div>
  );
}
