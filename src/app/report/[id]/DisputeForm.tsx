"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { DISPUTE_CATEGORIES } from "@/server/judgmentDisputeService";
import styles from "./dispute.module.css";

// 판정 이의제기 — **구매자 → 플랫폼의 단방향 클레임.**
//
// 이 창구가 없으면 "판정이 틀렸다"고 생각한 사람이 갈 곳은 카드사뿐이다. 차지백은
// 우리가 아무것도 못 하는 자리에서 돈이 빠지는 것이라, 그 전에 우리 안에서 끝낼
// 기회를 만드는 것이 이 화면의 목적이다.
//
// **자유 서술 칸을 주지 않는다.** 열어 두면 "이 리서처 사기꾼이다"가 들어오고,
// 그 순간 이 창구는 거래 분쟁 처리가 아니라 리서처에 대한 의견 게시판이 된다 —
// 투자자문업 해석 위험이 시작되는 지점이다. 대신 **사유는 고르고, 값은 적는다**:
// 고를 수 있는 것은 전부 데이터에 관한 주장이고, 함께 받는 것은 대조할 수치 하나다.
//
// 기본적으로 접혀 있다: 판정을 본 대다수는 이의가 없고, 열려 있는 신고 양식은
// 그 자체로 "이 판정은 의심스럽다"고 말한다.

export function DisputeForm({
  purchaseId,
  alreadyFiled,
}: {
  purchaseId: string;
  alreadyFiled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<string>("");
  const [observed, setObserved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (alreadyFiled) {
    return (
      <p className={styles.filed}>
        판정 검토를 요청하셨습니다. 확인되면 알림으로 결과를 알려드립니다.
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" className={styles.trigger} onClick={() => setOpen(true)}>
        판정이 실제 시세와 다른가요?
      </button>
    );
  }

  async function submit() {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/disputes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purchaseId, category, observed: observed.trim() || undefined }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? "접수하지 못했습니다");
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.box}>
      <p className={styles.lede}>
        <strong>판정 데이터에 대한 검토 요청</strong>입니다. 플랫폼이 판정에 쓴 시세와 규칙을
        다시 확인합니다 — 리서처에게 전달되지 않습니다.
      </p>

      <div className={styles.options}>
        {Object.entries(DISPUTE_CATEGORIES).map(([key, label]) => (
          <label key={key} className={styles.option}>
            <input
              type="radio"
              name="dispute-category"
              value={key}
              checked={category === key}
              onChange={() => setCategory(key)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      {/* 의견이 아니라 **대조할 수치**를 받는다 — 그래서 예시도 값의 모양으로 준다 */}
      <label className={styles.observedLabel}>
        확인하신 실제 값 (선택)
        <input
          className={styles.observed}
          value={observed}
          onChange={(e) => setObserved(e.target.value)}
          maxLength={100}
          placeholder="예: 8월 1일 종가 71,200원"
        />
      </label>

      {error && <p className={styles.error}>{error}</p>}

      <div className={styles.actions}>
        <button type="button" className={styles.cancel} onClick={() => setOpen(false)}>
          취소
        </button>
        <button
          type="button"
          className={styles.submit}
          onClick={submit}
          disabled={!category || busy}
        >
          {busy ? "접수 중…" : "검토 요청"}
        </button>
      </div>
    </div>
  );
}
