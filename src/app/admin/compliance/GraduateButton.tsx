"use client";

import { useState } from "react";
import type { RiskCategory } from "@/domain/compliance";
import type { FormalizationProbeResult } from "@/domain/formalizationProbe";
import { GraduateForm } from "./GraduateForm";
import a from "../admin.module.css";

/**
 * 졸업 폼의 문 — **접어 둔다.**
 *
 * 사전 목록은 훑는 화면이고 졸업은 드문 일이라, 항목마다 여섯 칸짜리 폼을 펼쳐 두면
 * 목록이 목록 구실을 못 한다. 그리고 접어 두는 것 자체가 마찰이라 나쁘지 않다 —
 * 졸업은 사전 보호를 끄는 결정이고, 훑다가 눌러지는 자리에 있으면 안 된다.
 */
export function GraduateButton(props: {
  phraseId: string;
  phrase: string;
  category: RiskCategory;
  studentMode: "live" | "shadow" | "off";
  minPerSide: number;
  maxPairSimilarity: number;
  /** 아래 여섯은 관문·경고 재료 (2026-09-01) — GraduateForm 주석 참고 */
  reasonMin: number;
  itemPackAskedAt: string | null;
  formStable: boolean;
  surfaceSummary: string;
  studentCoDetected: number;
  studentMissed: number;
  probe: FormalizationProbeResult | null;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" className={`${a.btn} ${a.btnGhost}`} onClick={() => setOpen(true)}>
        졸업시키기 — ARGOS에게 넘기고 대비쌍을 남깁니다
      </button>
    );
  }
  return <GraduateForm {...props} onClose={() => setOpen(false)} />;
}
