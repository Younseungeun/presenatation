// 검출 항목별 질문지 — **한 항목이 잡은 문장을 전부 모아** variation 공식화를 묻는 재학습 논의 자료
// (2026-09-01 창업자 지시).
//
// 사건별 질문지(teacherPack)는 판정 1건 = 질문지 1장이라, "'인스타그램' 때문에 걸린 것들"을
// 한자리에서 볼 수 없었다. 코드화(공식화)는 개별 variation 을 놓고 "어떤 표현·문맥 조건으로
// 적으면 규칙이 잡는가"를 정하는 일이라 **항목 단위**로 문장이 모여야 논의가 된다.
// 이 파일은 그 조립만 한다(순수). 데이터 수집은 server/itemTeacherPackService.
//
// 범위는 **학습표현 + 규칙 WARN** (창업자 확정). BLOCK 은 즉시거절이라 사람 판정이 안 붙고,
// ARGOS 단독 검출은 ruleId 가 없어 항목 단위로 모이지 않는다 — 둘 다 이 자료의 대상이 아니다.
//
// **답은 파싱하지 않는다.** 사건별 질문지의 답(parseTeacherAnswer)은 재학습 라벨이 되지만,
// 이 질문지의 답은 코드 조건의 초안이라 사람이 읽고 코드로 옮긴다. 형식 계약이 없다.

import type { RiskCategory } from './compliance';
import { RISK_CATEGORY_LABEL } from './compliance';

/**
 * PHRASE·RULE_WARN = 검출 항목 하나. ARGOS_CATEGORY = **ARGOS 만 잡았거나 놓친 확정 건을 유형별로
 * 모은 것** (2026-09-01, 졸업 강등 본선의 "계속 보다 보니 공식화 가능"을 지탱하는 자리).
 * ARGOS 소견은 문장을 짚지 못하므로(문서 전체 판정) 재료는 운영자가 반려 때 짚은 근거 문장뿐이다.
 */
export type ItemPackLayer = 'PHRASE' | 'RULE_WARN' | 'ARGOS_CATEGORY';

/** 걸린 문장 한 줄의 사람 판정 — detectionLadderService 의 정탐/오탐 분류와 **같은 잣대** */
export type ItemVerdict = 'TP' | 'FP' | 'MINOR' | 'PENDING';

export interface ItemEvidenceLine {
  /** 걸린 지점을 포함한 문맥 (사전 = hit 스냅샷 / 규칙 = 소견 quote) */
  sentence: string | null;
  /** 실제 출현형 (정규화 전) — 사전 hit 에만 있다. 어미·띄어쓰기 변형이 그대로 보인다 */
  surface?: string | null;
  /** 어느 해석 층이 잡았나 (L1_RAW …) — 규칙 소견에만 있다 */
  layer?: string | null;
  /** 부정·헷지 문맥 강도 (WEAK/null) — 사전 hit 에만 있다 */
  negation?: string | null;
  verdict: ItemVerdict;
  createdAt: Date;
}

export interface ItemPackStats {
  matched: number;
  truePos: number;
  falsePos: number;
  ageDays?: number;
  distinctResearchers?: number;
  negationHits?: number;
  distinctSurfaces?: number;
  topSurfaceShare?: number;
  /** 검출 항목 관리의 추천 (사유 포함) — 있으면 그대로 싣는다 */
  recommendation?: string | null;
  /** ARGOS_CATEGORY 만: 확정 건 중 ARGOS 가 잡은 수 / 놓친(통과 후 철회) 수 */
  argosDetected?: number;
  argosMissed?: number;
}

export interface ItemPackArgs {
  itemId: string;
  label: string;
  layer: ItemPackLayer;
  category?: RiskCategory | null;
  /** 규칙이면 그 규칙의 사유문 — 어떤 뜻으로 만든 규칙인지 */
  reason?: string | null;
  stats: ItemPackStats;
  /** 최신순. 조립기가 상한을 자른다 */
  evidence: ItemEvidenceLine[];
}

/** @근거 설계 사람이 한 번에 훑을 분량 — 사건별 질문지 한 장이 본문+규정이라 이미 길다.
 *  항목 질문지는 문장 목록이 몸통이라 60줄이면 충분히 패턴이 보이고, 넘치면 최근 것이 우선 */
export const ITEM_PACK_MAX_LINES = 60;
/** 출현형 요약 상위 개수 */
export const ITEM_PACK_MAX_SURFACES = 12;

const VERDICT_TITLE: Record<ItemVerdict, string> = {
  TP: '정탐 — 걸렸고 사람이 반려·철회로 확정',
  FP: '오탐 — 걸렸는데 사람이 "지적 부당"으로 승인 (정상 표현)',
  MINOR: '경미 — 걸렸고 지적은 타당하나 게시 막을 정도는 아니어서 승인',
  PENDING: '판정 전 — 아직 사람 결론이 없음',
};
const VERDICT_ORDER: ItemVerdict[] = ['TP', 'FP', 'MINOR', 'PENDING'];

const LAYER_TITLE: Record<ItemPackLayer, string> = {
  PHRASE: '학습표현 (운영자 사전)',
  RULE_WARN: '코드 규칙 WARN',
  ARGOS_CATEGORY: 'ARGOS 만 잡았거나 놓친 확정 건 (유형별 모음)',
};

/** 사람 판정을 사건별 질문지·사다리와 같은 4갈래로 접는다 */
export function classifyItemVerdict(
  operatorVerdict: string | null | undefined,
  aiFindingsValid: boolean | null | undefined,
): ItemVerdict {
  if (operatorVerdict === 'REJECTED' || operatorVerdict === 'TAKEDOWN') return 'TP';
  if (operatorVerdict === 'APPROVED') return aiFindingsValid === true ? 'MINOR' : 'FP';
  return 'PENDING';
}

/** 출현형 빈도 — 어미·띄어쓰기 변형이 몇 꼴인지 (공식화의 첫 재료) */
export function summarizeSurfaces(evidence: ItemEvidenceLine[]): Array<{ surface: string; n: number }> {
  const counts = new Map<string, number>();
  for (const e of evidence) if (e.surface) counts.set(e.surface, (counts.get(e.surface) ?? 0) + 1);
  return [...counts.entries()]
    .map(([surface, n]) => ({ surface, n }))
    .sort((a, b) => b.n - a.n || a.surface.localeCompare(b.surface));
}

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

function evidenceLine(e: ItemEvidenceLine): string {
  const tags: string[] = [];
  if (e.surface) tags.push(`출현형 "${e.surface}"`);
  if (e.layer) tags.push(e.layer);
  if (e.negation) tags.push(`부정 ${e.negation}`);
  const tag = tags.length ? `[${tags.join(' · ')}] ` : '';
  const sentence = e.sentence ? `“${e.sentence.replace(/\s+/g, ' ').trim()}”` : '(문맥 스냅샷 없음)';
  return `- ${fmtDate(e.createdAt)} ${tag}${sentence}`;
}

/**
 * 항목 질문지 본문. 순수 — 같은 입력이면 같은 출력.
 *
 * 구조: 항목 정체 → 성적 → 출현형 요약 → 걸린 문장(판정별 묶음) → 논의 항목.
 * 논의 항목의 어휘는 사건별 질문지 §3(코드화 사다리)·§4(관할 재검토)와 **같게** 둔다 —
 * 두 자료를 번갈아 읽는 사람이 같은 개념을 다른 말로 두 번 배우지 않게.
 */
export function assembleItemTeacherPack(args: ItemPackArgs): { title: string; text: string; count: number } {
  const { stats } = args;
  // 같은 문장이 같은 판정으로 여러 번 오면 한 줄이다 (재검수·카나리아가 같은 스냅샷을 반복 남긴다).
  // 최신 것을 남긴다 — 정렬이 최신순이라 처음 본 키가 곧 최신이다
  const seen = new Set<string>();
  const deduped = [...args.evidence]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .filter((e) => {
      const key = `${e.verdict}|${e.sentence ?? ''}|${e.surface ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const evidence = deduped.slice(0, ITEM_PACK_MAX_LINES);
  const truncated = deduped.length > evidence.length;
  const surfaces = summarizeSurfaces(evidence);
  const groups = new Map<ItemVerdict, ItemEvidenceLine[]>();
  for (const e of evidence) groups.set(e.verdict, [...(groups.get(e.verdict) ?? []), e]);

  const title = `검출 항목 질문지 — “${args.label}” [${LAYER_TITLE[args.layer]}]`;
  const lines: string[] = [
    '> **판정을 요청하는 자료가 아닙니다.** 아래는 검출 항목 **하나**가 지금까지 잡은 문장을',
    '> 사람 판정별로 모은 것입니다. 목적은 이 variation 들을 **어떤 표현·문맥 조건으로',
    '> 코드화(공식화)하면 규칙이 잡는가**를 정하는 것입니다. 직전에 다른 항목을 논의했다면',
    '> 그 결론이 이 항목에 스미지 않게 하세요 — 항목마다 형태가 다릅니다.',
    '',
    `# ${title}`,
    '',
    `- 항목 id: \`${args.itemId}\``,
    `- 유형: ${args.category ? RISK_CATEGORY_LABEL[args.category] : '—'}`,
    ...(args.reason ? [`- 규칙 사유문: ${args.reason}`] : []),
    `- 지금 있는 층: ${LAYER_TITLE[args.layer]}`,
    '',
    '## 성적 (운영자 판정으로 확정된 값)',
    '',
    `- 걸림 ${stats.matched} · 정탐 ${stats.truePos} · 오탐 ${stats.falsePos}` +
      (stats.ageDays != null ? ` · 관찰 ${stats.ageDays}일` : ''),
    ...(args.layer === 'PHRASE'
      ? [
          `- 서로 다른 리서처 ${stats.distinctResearchers ?? 0}명 · 부정 문맥 출현 ${stats.negationHits ?? 0}건 · ` +
            `표면형 ${stats.distinctSurfaces ?? 0}종(최빈 ${Math.round((stats.topSurfaceShare ?? 0) * 100)}%)`,
        ]
      : args.layer === 'ARGOS_CATEGORY'
        ? [
            `- ARGOS 가 잡은 확정 건 ${stats.argosDetected ?? 0} · ARGOS 가 놓친 확정 건(통과 후 철회) ${stats.argosMissed ?? 0}`,
            '- 이 유형에서 규칙·사전이 낸 소견은 없었습니다 — 아래 문장은 전부 **의미 추론만** 잡았거나 아무도 못 잡은 것입니다',
          ]
        : []),
    ...(stats.recommendation ? [`- 검출 항목 관리 추천: ${stats.recommendation}`] : ['- 검출 항목 관리 추천: 없음 (관문 조건 미충족)']),
    '',
    '## 출현형 요약 — 어미·띄어쓰기 변형',
    '',
    ...(surfaces.length === 0
      ? ['(출현형 스냅샷이 없습니다 — 규칙 소견은 출현형을 남기지 않고, 스냅샷 도입 전 hit 도 비어 있습니다)']
      : surfaces.slice(0, ITEM_PACK_MAX_SURFACES).map((s) => `- “${s.surface}” × ${s.n}`)),
    '',
    `## 걸린 문장 — 판정별 (${evidence.length}건${truncated ? `, 최근 ${ITEM_PACK_MAX_LINES}건만` : ''})`,
    '',
  ];

  if (evidence.length === 0) {
    lines.push('(아직 걸린 문장이 없습니다 — 등록 후 한 번도 안 걸렸거나 스냅샷 도입 전입니다)', '');
  } else {
    for (const v of VERDICT_ORDER) {
      const g = groups.get(v);
      if (!g || g.length === 0) continue;
      lines.push(`### ${VERDICT_TITLE[v]} — ${g.length}건`, '', ...g.map(evidenceLine), '');
    }
  }

  lines.push(
    '---',
    '',
    '## 논의 항목',
    '',
    '1. **variation 공식화** — 위 출현형과 정탐 문장을 놓고, 이 표현이 **어떤 꼴로 쓰이는가**를',
    '   조건으로 적어 주세요: 어미 변형(“보장” “보장이 되는” “보 장”), 동반 어휘(약속·유도·연락),',
    '   부정 범위, 앞뒤 문맥. **재사용 가능한 형태**여야 합니다 — 종목명·숫자·특정 리포트에만',
    '   맞는 낱말은 빼고, 너무 넓어 정상 산문에 걸리는 조건은 안 됩니다. 가능하면 정규식 초안까지.',
    '2. **정상 문장 비껴가기** — 오탐·경미·부정 문맥 건을 놓고, 정상 표현을 제외하는 문맥',
    '   조건이 무엇인지 적어 주세요. 오탐이 하나라도 있으면 그 문장이 왜 걸렸는지가 조건의 구멍입니다.',
    ...(args.layer === 'ARGOS_CATEGORY'
      ? [
          '3. **졸업 강등 본선 — 코드로 내릴 수 있나** — 이 문장들은 지금 **의미 추론(ARGOS)만이**',
          '   잡거나, 그마저 놓친 것입니다. 코드가 대개 더 효율적입니다(즉시 거절 권한·추론 비용 0·',
          '   장애 무관). 위 1번 조건이 성립하면 **내릴 수 있는 것**이고, 실행은 둘 중 하나입니다:',
          '   · **학습 표현 등록** — 문자열 하나로 잡히면 (재사용 가능한 짧은 꼴로)',
          '   · **코드 규칙 WARN** — "어떤 문맥에서만"이 필요하면',
          '   같은 뜻이 늘 다른 꼴로 와서(패러프레이즈) 1번 조건이 안 서면 **ARGOS 에 남깁니다** — 그때',
          '   ARGOS 가 놓친 건은 이동이 아니라 **재학습**으로 고칩니다.',
          '4. **놓친 건의 처방** — "ARGOS 가 놓친 확정 건"에 든 문장은 코드화가 되면 코드가, 안 되면',
          '   재학습이 맡습니다. 둘은 배타가 아닙니다 — 코드로 내리더라도 그 문장은 재학습 라벨에도 남깁니다.',
        ]
      : args.layer === 'PHRASE'
      ? [
          '3. **코드화 사다리 — 규칙 WARN 으로 올릴 수 있나** — 기준은 **문맥 조건을 코드로 적을 수',
          '   있는 완결성**입니다. 형태가 굳어 있어(늘 같은 꼴) 위 1번 조건이 성립하면 코드 규칙',
          '   WARN 후보입니다. 학습표현은 문자열 하나라 “어떤 문맥에서만”을 담을 수 없습니다 —',
          '   그 문맥을 코드로 적을 수 있을 때 승격이 뜻이 있습니다.',
          '4. **관할 재검토 — 형태 매칭인가, 의미 추론(ARGOS)인가** — 같은 뜻이 늘 **다른 꼴**로',
          '   와서(패러프레이즈) 위 1번 조건이 성립하지 않으면, 사다리 어느 눈금도 못 잡습니다.',
          '   그때는 뜻으로 잡아야 하는 표현이라 **ARGOS 졸업** 후보입니다. “공식화가 안 된다”는',
          '   판단은 여기서 사람이 내립니다 — 자동 추천은 “ARGOS 가 이미 잡는다(중복)”만 봅니다.',
        ]
      : [
          '3. **코드화 사다리 — BLOCK 으로 올릴 수 있나** — BLOCK 은 즉시 거절이라 되돌릴 사람이',
          '   없습니다. 위 2번의 정상 비껴가기 조건이 **오탐 0** 으로 측정돼야(평가셋·관찰) 자격이',
          '   생깁니다. 오탐이 남아 있으면 조건 재편이 먼저입니다.',
          '4. **관할 재검토 — 문맥을 코드로 못 가르면 ARGOS 위임(졸업)** — 형태는 맞는데 오탐이',
          '   반복되고 위 2번 조건이 코드로 안 적히면, 그 문맥 판단은 의미 추론의 몫입니다.',
          '   실패가 아니라 방식 교체입니다.',
        ]),
    '',
    '답은 자유 형식입니다 — 이 답은 재학습 라벨이 아니라 **코드 조건의 초안**이고, 사람이 읽고',
    '코드(규칙) 또는 사전 등록으로 옮깁니다.',
  );

  return { title, text: lines.join('\n'), count: evidence.length };
}
