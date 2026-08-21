"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { RISK_CATEGORY_LABEL, type RiskCategory } from "@/domain/compliance";
import { STUDENT_LABELS, isStudentLabel } from "@/domain/studentText";
import { charBigramJaccard } from "@/domain/textSimilarity";
import a from "../admin.module.css";

/**
 * **사전에서 나가는 유일한 문** (20차 X-2: 코드 승격은 금지, 출구는 졸업뿐).
 *
 * 이 화면이 없어서 지금까지 아무도 졸업시킬 수 없었고, 그동안 사전은 늘기만 했다.
 * 그 끝에 근사 감시 상한(200)과 밀어내기가 있는데, 밀어내기 경보는 *"졸업시켜 자리를
 * 비우십시오"* 라고 말한다 — 비울 방법이 없는 채로 경고만 오는 상태였다.
 *
 * ── 왜 6문장을 사람이 직접 쓰게 하는가 ─────────────────────────
 * 졸업은 "이 표현은 이제 학생이 맡는다"이고, 그 순간 사전 보호가 꺼진다. 학생이
 * 재학습하다 그 표현을 잊으면(치명적 망각) 아무도 안 막는 상태가 되므로, 대비쌍이
 * 유일한 방어선이다. 자동 생성은 20차에 기각됐다 — 생성기가 규칙과 같은 논리면
 * **규칙이 이미 잡는 것만 시험**하게 되어 동어반복이다.
 *
 * ── 왜 브라우저에서 자카드를 계산하는가 (확인서 Q2 → 회신 5호 동의) ──
 * 서버가 최종 관문이고 여기서 재는 것은 **미리 알려 주기 위해서만**이다. 누른 뒤에
 * 거절당하면 6문장을 다시 쓰게 된다. `charBigramJaccard` 는 금지 목록을 담지 않고,
 * "0.4 이상 거절"은 회피에 쓸 정보가 아니라 운영자가 알아야 할 규칙이다.
 * **컷오프를 화면에 숫자로 적지 않는다** — 실측 재조정되는 값이라 박아 두면 그날
 * 화면과 서버가 갈라진다. 다만 상수가 사는 곳(`phraseGraduationService`)은 prisma 를
 * 끌고 오는 서버 모듈이라 클라이언트에서 import 하면 번들에 들어간다. 그래서 **서버
 * 컴포넌트가 그 상수를 읽어 props 로 내려 준다** — 원천은 그대로 하나다.
 */

interface Side {
  text: string;
  category?: RiskCategory;
}

const blank = (n: number): Side[] => Array.from({ length: n }, () => ({ text: "" }));

/** 서비스의 하한과 같은 값 — 실제 리포트 문장처럼 쓰게 하려는 것이지 글자 수 시험이 아니다 */
const MIN_SENTENCE_LENGTH = 10;

export function GraduateForm({
  phraseId,
  phrase,
  category,
  studentMode,
  minPerSide,
  maxPairSimilarity,
  onClose,
}: {
  phraseId: string;
  phrase: string;
  /** 이 항목의 유형 — 위반 문장의 기본 유형이 된다 (학생 라벨 공간 안일 때만) */
  category: RiskCategory;
  studentMode: "live" | "shadow" | "off";
  /** 서버 상수 그대로 (GRADUATION_MIN_CASES_PER_SIDE) — 화면에 숫자를 박지 않는다 */
  minPerSide: number;
  /** 서버 상수 그대로 (GRADUATION_MAX_PAIR_SIMILARITY) */
  maxPairSimilarity: number;
  onClose: () => void;
}) {
  const router = useRouter();
  const fallback: RiskCategory | undefined = isStudentLabel(category) ? category : undefined;
  const [violations, setViolations] = useState<Side[]>(
    blank(minPerSide).map((s) => ({ ...s, category: fallback })),
  );
  const [normals, setNormals] = useState<Side[]>(blank(minPerSide));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const vProblems = sideProblems(violations, true, maxPairSimilarity);
  const nProblems = sideProblems(normals, false, maxPairSimilarity);
  const ready =
    !busy &&
    vProblems.length === 0 &&
    nProblems.length === 0 &&
    violations.every((s) => s.text.trim()) &&
    normals.every((s) => s.text.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/compliance/graduate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phraseId,
          cases: [
            ...violations.map((s) => ({
              text: s.text.trim(),
              expectViolation: true,
              category: s.category,
            })),
            ...normals.map((s) => ({ text: s.text.trim(), expectViolation: false })),
          ],
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "졸업시키지 못했습니다");
        return;
      }
      router.refresh();
      onClose();
    } catch {
      setError("서버에 닿지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={a.branch} style={{ marginTop: 10 }}>
      <div className={a.lbl}>
        졸업시키기
        <small>
          &ldquo;{phrase}&rdquo; 를 사전에서 내리고 <b>학생에게 넘깁니다</b>
        </small>
      </div>

      <div className={a.note}>
        졸업하면 이 표현은 사전에서 <b>꺼집니다.</b> 대신 아래 6문장이{" "}
        <b>영구 회귀 시험셋</b>이 되어, 앞으로 재학습한 모델은 여기서 하나라도 틀리면{" "}
        <b>채택되지 않습니다.</b> 이것이 학생이 이 표현을 잊는 것을 막는 유일한 방어선입니다.
      </div>

      {/* **그림자에서도 졸업을 막지 않는다** (C-3 (나)) — 채택 직전에 대비쌍을 미리 써
          두는 것은 정상 운영이고, 막으면 그 준비를 막는 셈이다. 다만 결과를 모른 채
          누르게 두지 않는다. 괄호가 중요하다: 과장하면 다음 경고를 안 믿는다 */}
      {studentMode !== "live" && (
        <div className={`${a.note} ${a.noteWarn}`}>
          <b>학생이 연수 중입니다.</b> 지금 졸업시키면 이 표현은 당분간 아무도 막지 않습니다
          (규칙·코드 패턴에 걸리는 부분은 계속 막힙니다). 대비쌍은 지금 써 두어도 됩니다 —{" "}
          <b>다음 재학습 채택 판정부터</b> 이 문항으로 시험합니다.
        </div>
      )}

      <CaseSide
        title="위반 문장"
        hint="학생이 반드시 잡아야 하는 문장입니다. 이 표현이 그대로 들어가지 않아도 됩니다 — 같은 뜻을 다르게 쓴 문장이 오히려 값집니다."
        sides={violations}
        setSides={setViolations}
        withCategory
        problems={vProblems}
      />
      <CaseSide
        title="정상 문장"
        hint="학생이 잡으면 안 되는 문장입니다. 같은 표현이 정상 맥락에 든 문장을 쓰세요 — 이쪽이 오탐을 막습니다."
        sides={normals}
        setSides={setNormals}
        problems={nProblems}
      />

      {error && <p className={a.error}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button type="button" className={`${a.btn} ${a.btnGhost}`} onClick={onClose} disabled={busy}>
          취소
        </button>
        <button type="button" className={a.btn} onClick={submit} disabled={!ready}>
          🔒 졸업시키기 — 되돌리려면 재활성화해야 합니다
        </button>
      </div>
      {!ready && !busy && (
        <div className={a.gate}>
          {[...vProblems, ...nProblems][0] ?? "여섯 문장을 모두 채워 주세요"}
        </div>
      )}
    </div>
  );
}

/**
 * 쓰는 동안 걸러 낸다 — **누른 뒤에 거절당하면 6문장을 다시 쓴다.**
 * 서버가 던지는 것과 같은 조건을 같은 순서로 본다(짧음 → 유형 → 복붙).
 */
function sideProblems(sides: Side[], violation: boolean, maxPairSimilarity: number): string[] {
  const out: string[] = [];
  const filled = sides.filter((s) => s.text.trim());
  for (const s of filled) {
    if (s.text.trim().length < MIN_SENTENCE_LENGTH) {
      out.push(`문장이 너무 짧습니다 (${MIN_SENTENCE_LENGTH}자 이상) — 실제 리포트 문장처럼 써 주세요`);
      break;
    }
  }
  if (violation && filled.some((s) => !s.category)) {
    out.push("위반 문장에는 유형이 필요합니다 — 학생이 낼 수 없는 유형이면 그 문항은 영원히 빨간불입니다");
  }
  // 쌍별 복붙 검사 — 명목 3문장·실질 1문장을 막는다
  for (let i = 0; i < filled.length; i++) {
    for (let j = i + 1; j < filled.length; j++) {
      const sim = charBigramJaccard(filled[i].text, filled[j].text);
      if (sim >= maxPairSimilarity) {
        out.push(
          `두 문장이 너무 닮았습니다 (유사도 ${(sim * 100).toFixed(0)}%) — 낱말만 바꾼 문장은 회귀 시험을 넓히지 못합니다. 상황이 다른 문장으로 다시 써 주세요.`,
        );
        return out;
      }
    }
  }
  return out;
}

function CaseSide({
  title,
  hint,
  sides,
  setSides,
  withCategory = false,
  problems,
}: {
  title: string;
  hint: string;
  sides: Side[];
  setSides: (next: Side[]) => void;
  withCategory?: boolean;
  problems: string[];
}) {
  const patch = (i: number, next: Partial<Side>) =>
    setSides(sides.map((s, k) => (k === i ? { ...s, ...next } : s)));

  return (
    <div style={{ marginTop: 12 }}>
      <div className={a.lbl}>
        {title}
        <small>{hint}</small>
      </div>
      {sides.map((s, i) => (
        <div key={i} className={a.field}>
          <textarea
            className={a.textarea}
            rows={2}
            value={s.text}
            onChange={(e) => patch(i, { text: e.target.value })}
            maxLength={400}
            placeholder={`${title} ${i + 1}`}
            aria-label={`${title} ${i + 1}`}
          />
          {withCategory && (
            <div className={a.chips} style={{ marginTop: 6 }}>
              {STUDENT_LABELS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`${a.pick} ${s.category === c ? a.pickOn : ""}`}
                  onClick={() => patch(i, { category: s.category === c ? undefined : c })}
                >
                  {RISK_CATEGORY_LABEL[c]}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <button
        type="button"
        className={`${a.btn} ${a.btnGhost}`}
        onClick={() => setSides([...sides, { text: "", category: sides[0]?.category }])}
      >
        문장 추가 — 많을수록 시험이 넓어집니다
      </button>
      {problems.map((p, i) => (
        <p key={i} className={a.hint} style={{ color: "var(--neg)", fontWeight: 600 }}>
          {p}
        </p>
      ))}
    </div>
  );
}
