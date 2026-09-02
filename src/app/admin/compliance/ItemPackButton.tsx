"use client";

import { useState } from "react";
import { CopyIcon } from "../../(app)/brand/Icons";
import a from "../admin.module.css";

// 검출 항목별 질문지 (2026-09-01 창업자 지시) — 표의 항목 행에서 펼쳐 **그 항목이 잡은 문장
// 전부**를 판정별로 묶은 질문지를 본다. 복사해 교사(Claude)에게 "이 variation 들을 어떤
// 조건으로 공식화하나"를 묻는 것이 용도. PhraseEvidence 와 같이 펼칠 때만 부른다.

export function ItemPackButton({ itemId }: { itemId: string }) {
  const [open, setOpen] = useState(false);
  const [pack, setPack] = useState<{ title: string; text: string; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    if (pack || busy) return pack;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/compliance/item-pack?item=${encodeURIComponent(itemId)}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "질문지를 만들지 못했습니다");
      setPack(json);
      return json as { title: string; text: string; count: number };
    } catch (e) {
      setError(e instanceof Error ? e.message : "오류가 발생했습니다");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    await load();
  }

  async function copy() {
    const p = pack ?? (await load());
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch {
      setError("클립보드 접근이 막혀 있습니다 — 주소창이 https인지 확인해 주세요");
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <button type="button" className={a.chip} onClick={toggle} disabled={busy}>
          {open ? "항목 질문지 접기 ▴" : "항목 질문지 ▾"}
        </button>
        {/* 복사 이미지 자체가 버튼 (TeacherBatchCopy 와 같은 형식) */}
        <button
          type="button"
          onClick={copy}
          disabled={busy}
          aria-label="항목 질문지 복사"
          title="질문지 복사"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 26,
            height: 26,
            padding: 0,
            border: "none",
            background: "transparent",
            cursor: busy ? "default" : "pointer",
            color: copied ? "#0e6f5c" : "var(--text-dim)",
          }}
        >
          <CopyIcon />
        </button>
        {(busy || copied) && (
          <span style={{ fontSize: 12, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
            {busy ? "만드는 중…" : "복사됨"}
          </span>
        )}
      </span>
      {error && (
        <p className={a.hint} style={{ color: "var(--warn)" }}>
          {error}
        </p>
      )}
      {open && pack && (
        <pre
          style={{
            margin: "8px 0 0",
            padding: "10px 12px",
            borderRadius: 8,
            background: "var(--surface-1, #f2f4f6)",
            fontSize: 12,
            lineHeight: 1.65,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
            color: "var(--text)",
            maxHeight: "50vh",
            overflowY: "auto",
            minWidth: 280,
          }}
        >
          {pack.text}
        </pre>
      )}
    </div>
  );
}
