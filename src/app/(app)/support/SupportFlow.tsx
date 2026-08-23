"use client";

import { useState } from "react";
import {
  SUPPORT_DETAIL_MAX,
  SUPPORT_DETAIL_MIN,
  SUPPORT_TOPIC_ORDER,
  SUPPORT_TOPIC_SPECS,
  type SupportTopic,
} from "@/domain/supportTopics";
import researcher from "../researcher/researcher.module.css";
import styles from "./support.module.css";

// 문의 흐름 — **주제 고르기 → 먼저 답 보기 → 그래도 남기기**의 3단.
//
// 한 화면에 다 펼치지 않는다. 폼이 보이면 안내를 읽지 않고, 안내를 안 읽으면
// 이미 답이 있는 문의가 그대로 접수된다 — 1인 운영에서 그게 가장 비싼 낭비다.
//
// '기타'만 경고를 읽고 체크해야 입력창이 열린다. 투자 질문이 들어올 수 있는 유일한
// 자리라서다. **막는 장치가 아니라 읽게 만드는 장치다** — 읽고 체크한 사람은
// 투자 질문을 적지 않고, 적더라도 답을 기대하지 않는다.

export function SupportFlow() {
  const [topic, setTopic] = useState<SupportTopic | null>(null);
  const [acked, setAcked] = useState(false);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const reset = () => {
    setTopic(null);
    setAcked(false);
    setDetail("");
    setError(null);
    setDone(false);
  };

  if (!topic) {
    return (
      <div className={styles.topics}>
        {SUPPORT_TOPIC_ORDER.map((t) => {
          const spec = SUPPORT_TOPIC_SPECS[t];
          return (
            <button key={t} className={styles.topic} onClick={() => setTopic(t)}>
              <span className={styles.tBody}>
                <span className={styles.tLabel}>{spec.label}</span>
                <span className={styles.tHint}>{spec.hint}</span>
              </span>
              <span className={styles.tGo} aria-hidden="true">
                ›
              </span>
            </button>
          );
        })}
      </div>
    );
  }

  const spec = SUPPORT_TOPIC_SPECS[topic];
  // 경고가 있는 주제는 체크 전까지 입력창이 잠긴다
  const locked = !!spec.gate && !acked;

  if (done) {
    return (
      <div>
        <button className={styles.back} onClick={reset}>
          ‹ 다른 문의하기
        </button>
        <p className={styles.answer}>
          문의가 접수되었습니다. 확인 후 알림으로 답변드리겠습니다.{"\n"}
          답변은 이 화면 아래 &lsquo;내 문의&rsquo;에서도 다시 볼 수 있습니다.
        </p>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, detail }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "접수에 실패했습니다");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "접수에 실패했습니다");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button className={styles.back} onClick={reset}>
        ‹ 주제 다시 고르기
      </button>

      <h2 style={{ fontSize: 17, fontWeight: 800, marginTop: 4 }}>{spec.label}</h2>

      {/* 폼보다 먼저, 폼보다 눈에 띄게 — 여기서 끝나는 것이 가장 좋은 결과다 */}
      <div className={styles.answer}>{spec.selfServe}</div>

      {spec.gate && (
        <div className={styles.gate}>
          <p
            className={styles.gateText}
            dangerouslySetInnerHTML={{
              __html: spec.gate.replace(
                /\*\*(.+?)\*\*/g,
                "<strong>$1</strong>",
              ),
            }}
          />
          <label className={styles.gateCheck}>
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
            />
            <span>확인했습니다</span>
          </label>
        </div>
      )}

      <form
        onSubmit={submit}
        className={`${researcher.form} ${locked ? styles.locked : ""}`}
        aria-hidden={locked}
      >
        <label className={researcher.label}>
          그래도 문의가 남아 있다면 적어 주세요
          <textarea
            className={researcher.input}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            placeholder={spec.placeholder}
            rows={5}
            required
            minLength={SUPPORT_DETAIL_MIN}
            maxLength={SUPPORT_DETAIL_MAX}
            disabled={locked}
          />
        </label>

        {error && <p className={researcher.error}>{error}</p>}

        <button
          type="submit"
          className={researcher.primaryBtn}
          disabled={busy || locked || detail.trim().length < SUPPORT_DETAIL_MIN}
        >
          {busy ? "접수 중…" : "문의 남기기"}
        </button>
      </form>
    </div>
  );
}
