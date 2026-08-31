import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import {
  RISK_CATEGORY_LABEL,
  type Finding,
  type RiskCategory,
  type ScreeningInput,
} from '@/domain/compliance';
import { isStudentLabel, STUDENT_LABELS } from '@/domain/studentText';
import { teacherPackId } from '@/domain/teacherAnswer';
import type { RiskLevel } from '@/domain/instrumentRisk';
import { buildUserMessage, SYSTEM_PROMPT } from '@/infra/compliance/claudeScreener';
import type { CalibrationExample } from '@/domain/screeningAccuracy';
import { targetPriceToMagnitudePct } from '@/domain/scoring';
import { getDetectionLadder } from './detectionLadderService';

// **2차를 사람이 나른다** (2026-08-21 사용자 확정).
//
// AI 검수기가 연결돼 있지 않으면 2차가 통째로 건너뛰어지고, 1차 소견이 있는 건은
// 그대로 운영자 큐에 쌓인다. 그때 운영자가 할 일은 **직접 교사에게 물어보는 것**인데,
// 물어볼 재료를 손으로 조립하면 매번 다른 기준의 답이 나오고, 그 답으로 붙인 라벨이
// 학습셋에 섞이는 순간 오염이 된다. 조립을 서버가 하고 화면은 나르는 일만 한다.
//
// ── 지켜야 할 것: 규정도 **문제지도** 복제하지 않는다 (18차 V-2) ──────
// 처음 이 파일은 `SYSTEM_PROMPT` 만 인용하고 원문은 `buildStudentText` 로 따로 조립했다.
// 그 결과 **규정문이 사용자 메시지에 있다고 말한 것 셋이 하나도 없었다**:
//
//   규정문: "무작위 경계(BOUNDARY)로 감싼 원문이 들어옵니다"      → 경계가 없었다
//   규정문: "거래소가 위험을 경고한 종목인데(사용자 메시지에 표시됨)" → 표시가 없었다
//   규정문: "표시된 구간 경계로 판정하세요"                        → 눈금이 없었다
//
// 교사는 있지도 않은 봉투를 찾으라는 지시를 받았고, MISSING_DISCLOSURE 를 **영원히
// 판정할 수 없었고**, 크기를 규정문이 명시적으로 금지한 "감각"으로 판정했다.
//
// 규정문과 사용자 메시지는 **한 쌍으로 설계된 것**이라 한쪽만 인용하면 어긋난다.
// 그래서 `buildUserMessage` — 자동 경로가 쓰는 바로 그 함수 — 를 그대로 부른다.
// 경계·위험종목·눈금·교정 사례가 전부 거기서 나온다.
//
// ── 교사 입력 ≠ 학생 입력 ────────────────────────────────────────────
// 학생 입력은 `buildStudentText` 여야 한다(학생이 추론 때 실제로 받는 것). 교사 입력은
// 판정 근거라 규칙이 아는 모든 맥락을 받아야 한다. 둘 다 같은 `ScreeningInput` 하나에서
// 나오므로 어긋나지 않는다 — 학습 라벨로 옮길 때 학생 텍스트를 그때 다시 만든다.

/** 교사가 답으로 쓸 수 있는 유형인가 — 학생 라벨 공간과 같다 */
function answerable(c: RiskCategory): boolean {
  return isStudentLabel(c);
}

export interface TeacherPack {
  /** 대화창에 그대로 붙여 넣을 전체 텍스트 */
  text: string;
  /** 이 답이 어느 건의 것이어야 하는가 — 파싱할 때 대조한다 */
  packId: string;
  /** 화면이 "무엇을 물어보는지"를 한 줄로 말할 때 쓴다 */
  reportTitle: string;
}

export interface TeacherPackDeps {
  /** 지금 쓰는 교사 표식 — 답을 기록할 때 이 값이 라벨에 박힌다 (18차 V-4) */
  teacherTag: string;
  /**
   * 교정 사례 — **교사가 틀렸고 사람이 고친 기록만** (18차 V-5).
   *
   * 교사가 맞힌 것을 다시 먹이는 것은 의미가 없다. 자동 경로처럼 아무 오탐이나 넣으면
   * 교사→운영자→교정→교사 의 순환이 생기는데, 불일치 건만 넣으면 그 고리에서
   * **사람이 방향을 튼 지점**만 남는다.
   */
  corrections: CalibrationExample[];
}

/**
 * 이 건의 소견을 낸 검출 항목의 **누적 성적** — 사다리 논의의 객관 재료 (2026-08-31).
 *
 * 질문지의 3·4번(코드화 사다리·관할 재검토)은 항목의 실적으로 판단해야 하는 논의인데,
 * 예전 질문지에는 그 숫자가 없었다 — 검출 항목 관리가 집계해 둔 값이 화면(상세)에는
 * 있고 정작 논의장으로 들고 가는 문서에는 빠져 있었다. 걸림/정탐/오탐과 층·추천을
 * 소견 옆에 실어, 창업자가 화면을 오가지 않고 문서 하나로 사다리를 논의할 수 있게 한다.
 */
export interface LadderHistoryLine {
  /** 항목 표시명 — 사전 표현 원문 또는 코드 규칙 id */
  label: string;
  /** 지금 있는 층 (학습표현 / 규칙 WARN / 규칙 BLOCK / IRIS=졸업 관찰 중) */
  layer: 'PHRASE' | 'RULE_WARN' | 'RULE_BLOCK' | 'IRIS';
  matched: number;
  truePos: number;
  falsePos: number;
  /** 졸업 관찰의 IRIS 미탐 수 — IRIS 층(졸업 표현)만 */
  studentMissCount?: number;
  /** 검출 항목 관리의 추천 이동 — 있으면 그대로 싣는다 (사유 포함) */
  recommendation?: string | null;
}

export async function buildTeacherPack(
  prisma: PrismaClient,
  reviewId: string,
  deps: TeacherPackDeps,
): Promise<TeacherPack | null> {
  const review = await prisma.complianceReview.findUnique({
    where: { id: reviewId },
    select: {
      id: true,
      findingsJson: true,
      createdAt: true,
      // 사람 판정 — 이 자료의 절반이다. 자동 검수와 **나란히** 놓아야 "무엇이 갈렸나"가 보인다
      operatorVerdict: true,
      operatorReason: true,
      operatorCategories: true,
      aiFindingsValid: true,
      report: {
        select: {
          title: true,
          summary: true,
          content: true,
          predictionCard: {
            select: {
              assetClass: true,
              ticker: true,
              assetName: true,
              direction: true,
              targetType: true,
              targetValue: true,
              basePrice: true,
              deadline: true,
              confidence: true,
            },
          },
        },
      },
    },
  });
  if (!review) return null;

  const r = review.report;
  const card = r.predictionCard;

  // 위험종목 표시는 종목 표에서 온다 — 규정문이 "사용자 메시지에 표시됨"이라고 쓴 그것.
  // 조회에 실패해도 질문지는 나가야 한다(교사에게 못 묻는 것보다 낫다)
  const instrument = card
    ? await prisma.instrument
        .findFirst({
          where: { assetClass: card.assetClass, ticker: card.ticker },
          select: { riskLevel: true, riskNote: true },
        })
        .catch(() => null)
    : null;

  const input: ScreeningInput = {
    title: r.title,
    summary: r.summary,
    content: r.content,
    assetClass: (card?.assetClass ?? 'KR_EQUITY') as ScreeningInput['assetClass'],
    assetName: card?.assetName ?? '',
    direction: card?.direction === 'DOWN' ? 'DOWN' : 'UP',
    riskLevel: (instrument?.riskLevel as RiskLevel | undefined) ?? undefined,
    riskNote: instrument?.riskNote ?? null,
    targetType: (card?.targetType ?? undefined) as ScreeningInput['targetType'],
    targetLabel: card?.targetType === 'TARGET_PRICE' ? String(card.targetValue) : null,
    magnitudePct: cardMagnitude(card),
    horizonDays: card
      ? (card.deadline.getTime() - review.createdAt.getTime()) / 86_400_000
      : null,
    confidence: card?.confidence ?? null,
  };

  const findings = parseFindings(review.findingsJson);

  // 사다리 이력 — 이 건의 소견을 낸 항목만 골라 싣는다. 집계 실패는 결측이지 사고가
  // 아니다(질문지는 이력 없이도 나가야 한다 — 교사에게 못 묻는 것보다 낫다)
  const findingIds = new Set(findings.map((f) => f.ruleId).filter(Boolean) as string[]);
  const itemHistory: LadderHistoryLine[] =
    findingIds.size === 0
      ? []
      : await getDetectionLadder(prisma)
          .then((rows) =>
            rows
              .filter((row) => findingIds.has(row.id))
              .map((row) => ({
                label: row.label,
                layer: row.layer,
                matched: row.matched,
                truePos: row.truePos,
                falsePos: row.falsePos,
                studentMissCount: row.studentMissCount,
                recommendation: row.recommendation?.reason ?? null,
              })),
          )
          .catch(() => []);

  return {
    ...assembleTeacherPack({
      packId: teacherPackId(review.id),
      input,
      findings,
      corrections: deps.corrections,
      humanVerdict: readHumanVerdict(review),
      itemHistory,
    }),
    reportTitle: r.title,
  };
}

/** 사람 판정 — 네 칸을 하나로 묶는다. 아직 판정 전이면 null */
export interface HumanVerdict {
  // MISSED = 검수 통과 후 신고로 잡혔는데 이미 닫혀 있어 내리지 못한 미탐.
  // 처분만 다를 뿐 관측은 TAKEDOWN 과 같은 '검수가 놓친 위반'이라(screeningAccuracy.isMiss),
  // 교사 질문지에서도 같은 미탐으로 다룬다
  verdict: 'APPROVED' | 'REJECTED' | 'KEPT' | 'TAKEDOWN' | 'MISSED';
  /** 운영자가 인정한 실제 위반 유형 — 비었으면 "검수 소견 그대로 인정" */
  categories: RiskCategory[];
  /** 승인 시: 지적 자체는 타당했는가 (경미 ↔ 오탐) */
  findingsValid: boolean | null;
  reason: string | null;
}

function readHumanVerdict(review: {
  operatorVerdict: string | null;
  operatorReason: string | null;
  operatorCategories: string | null;
  aiFindingsValid: boolean | null;
}): HumanVerdict | null {
  const v = review.operatorVerdict;
  if (v !== 'APPROVED' && v !== 'REJECTED' && v !== 'KEPT' && v !== 'TAKEDOWN' && v !== 'MISSED')
    return null;
  let categories: RiskCategory[] = [];
  try {
    const parsed = JSON.parse(review.operatorCategories ?? '[]');
    if (Array.isArray(parsed)) categories = parsed as RiskCategory[];
  } catch {
    /* 깨진 JSON 은 "유형 미지목"으로 본다 */
  }
  return {
    verdict: v,
    categories,
    findingsValid: review.aiFindingsValid,
    reason: review.operatorReason,
  };
}

/**
 * 질문지 조립 — **DB를 모른다.**
 *
 * 떼어 둔 이유: 맥락 이월 실험(`npm run probe:bleed`)이 검수 기록 없이 같은 질문지를
 * 만들어야 한다. 실험이 다른 조립기를 쓰면 재는 대상이 운영과 달라져 결과가 무의미하다 —
 * 이 저장소가 이미 한 번 겪은 모양이다(탐침에서만 참이던 92%).
 */
export function assembleTeacherPack(args: {
  packId: string;
  input: ScreeningInput;
  findings: Finding[];
  corrections: CalibrationExample[];
  /** 사람 판정 — 이 자료의 절반. 없으면(판정 전) 비교가 성립하지 않는다 */
  humanVerdict?: HumanVerdict | null;
  /** 소견을 낸 항목들의 누적 성적 — 사다리 논의 재료 (없으면 그 절만 빠진다) */
  itemHistory?: LadderHistoryLine[];
  /** 시험이 고정값을 넣는다. 운영에서는 비워 두어 **부를 때마다 새로** 만든다 */
  boundary?: string;
}): { text: string; packId: string } {
  // **경계는 부를 때마다 새로 만든다.** 고정하면 리서처가 본문에 같은 값을 적어
  // 구간을 빠져나갈 수 있다 (`[/본문 BOUNDARY-고정값]` 뒤에 지시를 이어 쓰는 방식)
  const boundary = args.boundary ?? randomBytes(8).toString('hex');
  const body = buildUserMessage(args.input, boundary, args.corrections);

  const text = [
    ...contextReset(),
    '',
    '# 검수 판정 비교 — 사람 vs 자동 검수(RULE+IRIS) · 재학습 논의',
    '',
    '**이 자료는 판정을 요청하는 것이 아닙니다.** 운영자(사람)가 이미 내린 판정과',
    '자동 검수(규칙 엔진 + IRIS)의 판정을 나란히 놓은 것입니다. 둘이 어떻게, 왜 갈렸는지',
    `살펴보고 논의해 주세요. **${caseGuide(args.humanVerdict ?? null).headline}**`,
    '',
    '판정을 다시 내려 달라는 것이 아니라 — 사람 판정은 이미 확정입니다 — **그 판정을',
    '자동 검수가 재현하게 만드는 방법**을 찾는 것이 목적입니다.',
    '',
    '---',
    '',
    ...humanVerdictBlock(args.humanVerdict ?? null),
    '',
    '---',
    '',
    ...firstTierBlock(args.findings),
    '',
    ...ladderHistoryBlock(args.itemHistory ?? []),
    '---',
    '',
    `<규정>\n${SYSTEM_PROMPT}\n</규정>`,
    '',
    '---',
    '',
    `## 대상 리포트  [${args.packId}]`,
    '',
    body,
    '',
    '---',
    '',
    ...discussionFormat(args.packId, args.humanVerdict ?? null),
    '',
  ].join('\n');

  // 무결성 머리글은 **본문이 확정된 뒤에** 붙인다 — 자기 자신을 세면 값이 안 맞는다
  return { text: withIntegrityHeader(text), packId: args.packId };
}

/**
 * **사람 판정 — 이 자료의 절반이다.**
 *
 * 자동 검수 소견만 실으면 "판정해 주세요"와 다를 게 없다. 사람이 내린 결론을 나란히
 * 놓아야 "무엇이 갈렸나 → 왜 → 어떻게 재현시킬까"의 논의가 성립한다.
 *
 * 판정 전(null)이면 비교가 성립하지 않으므로 그 사실을 명시한다 — 화면(AskTeacher)이
 * 판정 뒤에만 복사를 허용하지만, 서버 조립기도 혼자 옳아야 한다.
 */
function humanVerdictBlock(v: HumanVerdict | null): string[] {
  if (!v) {
    return [
      '## 사람 판정 (운영자)',
      '',
      '**아직 판정 전입니다.** 이 자료는 운영자가 승인·반려를 결정한 뒤에 만들어야',
      '비교가 성립합니다. 먼저 검수 상세 화면에서 판정을 기록해 주세요.',
    ];
  }
  const label: Record<HumanVerdict['verdict'], string> = {
    APPROVED: '승인 (게시 허용)',
    REJECTED: '반려 (초안 복귀)',
    KEPT: '게시 유지',
    TAKEDOWN: '강제 철회 (게시 중단·전액 환불)',
    MISSED: '미탐 (검수 통과 후 신고로 확인 — 이미 닫혀 내리지 못함)',
  };
  const out = ['## 사람 판정 (운영자)', '', `- **결론: ${label[v.verdict]}**`];

  const rejectedLike =
    v.verdict === 'REJECTED' || v.verdict === 'TAKEDOWN' || v.verdict === 'MISSED';
  if (rejectedLike) {
    out.push(
      v.categories.length > 0
        ? `- 인정한 위반 유형: ${v.categories.map((c) => RISK_CATEGORY_LABEL[c] ?? c).join(' · ')}`
        : '- 인정한 위반 유형: (검수 소견을 그대로 인정 — 별도 지목 없음)',
    );
  } else {
    // 승인은 세 갈래다 — 오탐 / 경미 / (소견 없음). aiFindingsValid 가 그걸 가른다
    out.push(
      v.findingsValid === true
        ? '- 소견 판단: **경미** — 지적은 타당했으나 게시를 막을 정도는 아니었다'
        : v.findingsValid === false
          ? '- 소견 판단: **오탐** — 애초에 잘못 잡았다 (규칙·모델을 고쳐야 하는 자리)'
          : '- 소견 판단: (해당 없음)',
    );
  }
  if (v.reason?.trim()) out.push(`- 사유: ${v.reason.trim()}`);
  return out;
}

/**
 * **축적된 기준은 따르되, 앞 건의 판정이 이 건에 스미는 것만 막는다** (2026-08-26 창업자 확정).
 *
 * 두 가지가 완전히 다르다 — 앞 문구는 이 둘을 뭉뚱그려 "앞 맥락 다 지워라"였고,
 * 그러면 쌓인 판례까지 버리라는 것처럼 읽혔다:
 *
 *   A. 시스템에 쌓인 과거 판정 데이터 — **자산이다.** 규정·교정 사례로 정제돼 들어오고
 *      (규정문·corrections), 교사는 그것을 기준으로 삼아야 한다. 판례를 보는 판사와 같다.
 *   B. 같은 창에서 방금 물어본 앞 건의 답 — **오염이다.** 검증된 라벨이 아니라 우연히
 *      옆에 있어 새어든 것으로, 앞 건이 위반이었으면 이 건도 위반 쪽으로 기운다.
 *
 * 막는 것은 B뿐이다. A는 오히려 따르라고 명시한다.
 *
 * 코드가 강제할 수 있는 것은 이 문구뿐이다 — 운영자가 새 대화를 여는지는 코드가 모른다.
 * 답 파싱이 id 를 대조해 **앞 건의 답을 복사한 경우**를 잡는 것(teacherAnswer)이 나머지 겹이다.
 */
function contextReset(): string[] {
  return [
    '> **과거의 판정 기준은 따르되, 직전에 판정한 건의 결론이 이 건에 스미지 않게 하세요.**',
    '> 아래 <규정>과 교정 사례는 그동안 쌓인 판단 기준이므로 그대로 근거로 삼으세요.',
    '> 다만 같은 창에서 방금 다른 건을 판정했다면, 그 건이 위반이었는지 아닌지가',
    '> **이 건의 엄격도를 밀지 않도록** 주의하세요. 그건 검증된 기준이 아니라 우연한 순서일',
    '> 뿐입니다. 앞 건과의 일관성이 아니라 **이 건을 규정에 비춘 객관적 판정**이 우선입니다.',
  ];
}

/**
 * 붙여넣기 잘림 방어 (18차 V-2).
 *
 * 브라우저 입력 폼이 긴 텍스트의 말단을 **소리 없이** 잘라 버릴 수 있다. 잘리면 뒤쪽
 * 위반이 통째로 안 보이는데 교사도 운영자도 그 사실을 모른다 — 판정은 정상으로 보인다.
 *
 * 그래서 **맨 위에** 총 길이와 마지막 낱말을 적는다. 머리글은 문서의 처음이라 잘려도
 * 남고, 교사가 대조해 "안 맞으니 판정할 수 없다"고 거절할 수 있다.
 * (검토가 지적한 한계: 폼이 **앞쪽부터** 자르면 이 머리글도 사라진다. 그때는 교사가
 *  머리글 없는 문서를 받으므로, 규정문이 아니라 이 형식 자체가 신호가 된다.)
 */
function withIntegrityHeader(body: string): string {
  const words = body.trim().split(/\s+/);
  const last = words[words.length - 1] ?? '';
  return [
    '```',
    // 길이는 **머리글 아래**만 센다 — 전체를 세면 머리글이 자기 자신을 세게 되어
    // 값이 성립하지 않는다. 실제로 잘림을 잡는 것은 마지막 낱말 쪽이다
    `[문서 무결성] 이 줄 아래 본문 ${body.length}자 · 마지막 낱말: "${last}"`,
    '문서의 맨 끝이 이 낱말이 아니면 **붙여넣기가 잘린 것입니다.**',
    '그때는 판정하지 말고 "문서가 잘렸습니다"라고만 답해 주세요.',
    '```',
    '',
    body,
  ].join('\n');
}

/**
 * 1차가 짚은 것 — **답할 수 있는 것과 문맥으로만 볼 것을 갈라 보여준다** (18차 V-1).
 *
 * `MISSING_DISCLOSURE`·`RISKY_INSTRUMENT` 는 종목 데이터로 결정론적으로 판정되므로
 * 학생 라벨 공간 밖이고, 교사가 답에 쓸 수 없다. 그렇다고 **감추면 안 된다** —
 * 규칙이 왜 이 문서를 보류시켰는지 모르면 교사는 다른 곳에서 있지도 않은 위반 사유를
 * 지어내고, 그게 그대로 오탐이 된다.
 *
 * 답을 유도하지 않는 이유는 그대로 지킨다: "이게 정답"이라고 적으면 독립 판정이 아니다.
 */
function firstTierBlock(findings: Finding[]): string[] {
  if (findings.length === 0)
    return ['## 자동 검수(RULE+IRIS) 판정', '', '(소견 없음 — 자동 검수는 위반을 못 찾았다)'];

  const line = (f: Finding) =>
    `- [${RISK_CATEGORY_LABEL[f.category] ?? f.category}] "${f.quote}"`;
  const open = findings.filter((f) => answerable(f.category));
  const context = findings.filter((f) => !answerable(f.category));

  const out = ['## 자동 검수(RULE+IRIS) 판정', ''];
  out.push(open.length > 0 ? open.map(line).join('\n') : '(위반 유형 소견 없음 — 자동 검수는 깨끗하다고 봤다)');

  if (context.length > 0) {
    out.push(
      '',
      '### 읽기 전용 문맥 — 이 소견은 **재학습 라벨에 넣지 마세요**',
      '',
      '아래는 종목 데이터로 결정되는 유형이라 규칙이 이미 확정했고, 학생 라벨 공간',
      '밖입니다. **이 문서가 왜 보류됐는지 알려 드리려고** 싣습니다 — 이것 때문에 없는',
      '위반을 지어내지 마세요.',
      '',
      context.map(line).join('\n'),
    );
  }
  return out;
}

/**
 * 소견을 낸 항목들의 **누적 성적** — 사다리 논의(3·4번)의 객관 재료 (2026-08-31).
 *
 * 재학습 라벨이 아니라 **논의 맥락**이다 — 읽기 전용 문맥과 같은 규율로, 라벨에 넣지
 * 말라고 명시한다. 이력이 없으면(집계 실패·소견 무 ruleId) 절 자체가 빠진다.
 */
function ladderHistoryBlock(history: LadderHistoryLine[]): string[] {
  if (history.length === 0) return [];
  const layerLabel: Record<LadderHistoryLine['layer'], string> = {
    PHRASE: '학습표현',
    RULE_WARN: '규칙 WARN',
    RULE_BLOCK: '규칙 BLOCK',
    IRIS: 'IRIS (졸업 관찰 중)',
  };
  const line = (h: LadderHistoryLine) => {
    const parts = [
      `- **${h.label}** [${layerLabel[h.layer]}] — 걸림 ${h.matched} · 정탐 ${h.truePos} · 오탐 ${h.falsePos}`,
    ];
    if (h.layer === 'IRIS') parts.push(`  · 졸업 관찰 미탐 ${h.studentMissCount ?? 0}건`);
    if (h.recommendation) parts.push(`  · 검출 항목 관리 추천: ${h.recommendation}`);
    return parts.join('\n');
  };
  return [
    '### 검출 항목 이력 — 사다리 논의 재료 (재학습 라벨에 넣지 마세요)',
    '',
    '이 건의 소견을 낸 항목들이 지금까지 쌓은 성적입니다. 3·4번(코드화 사다리·관할',
    '재검토)은 이 숫자로 논의해 주세요 — 정탐/오탐은 운영자 판정으로 확정된 값입니다.',
    '',
    history.map(line).join('\n'),
    '',
  ];
}

/**
 * **케이스별 논의 방향** (2026-08-27 창업자 지시). 사람이 무슨 판정을 내렸는지에 따라
 * 물어볼 것이 다르다:
 *   반려          → 모델이 놓쳤거나 약하게 봤다 → 학습 표현 등록 + 재학습 + (필요시) BLOCK 승격
 *   강제 철회      → 모델이 통과시킨 것을 사람이 내렸다(모델이 놓침) → 위와 같되 '왜 못 잡았나'가 핵심
 *   승인 + 지적 타당 → 지적은 맞지만 게시 막을 정도 아님 → **심각도 조정**(과잉 차단을 줄이는 재학습)
 *   승인 + 오탐    → 애초에 잘못 잡음 → **규칙 점검 + 재학습**(정상 표현을 오탐 안 하게)
 *   게시 유지      → (신고 기각) 사람이 문제없다고 봄 → 유의할 점만
 */
function caseGuide(v: HumanVerdict | null): { headline: string; points: string[] } {
  const rejectLike = {
    headline:
      '사람이 위반으로 보고 내린 건입니다 — 자동 검수가 다음엔 이걸 잡게 만드는 방법을 논의해 주세요.',
    points: [
      '1. **왜 갈렸나** — 사람은 위반으로 봤는데 자동 검수는 어디서 놓쳤나 (본문의 어느 표현/문맥)',
      '2. **IRIS 재학습** — 비슷한 표현을 앞으로 맞히려면 학생 모델이 어떤 특징을 잡아야 하나',
      // 3~4번은 별개 선택지가 아니라 **한 사다리의 눈금**이다 (2026-08-31 창업자 확정 어휘).
      // 갈림의 기준은 "이 표현의 문맥 조건을 코드로 얼마나 완결되게 적을 수 있는가" —
      // 위로 갈수록(등록→WARN→BLOCK) 완결성 요구가 높아지고, BLOCK 은 오탐 0 이 측정돼야 한다
      '3. **코드화 사다리 — 어느 눈금까지 올릴 수 있나** — 이 표현을 잡는 자리는 세 눈금 중',
      '   하나입니다. 기준은 **문맥 조건을 코드로 적을 수 있는 완결성**입니다:',
      '   · **학습 표현 등록** (완결성 최소) — 문자열 하나. 재사용 가능한 형태로(종목명·숫자를',
      '     뺀, 너무 넓지 않게). 등록하면 **항상 WARN** 으로 동작합니다',
      '   · **코드 규칙 WARN** — "어떤 문맥에서만"(약속 어미·유도 어휘·부정 범위)을 코드로',
      '     적을 수 있을 때. 형태가 굳어 있어야(늘 같은 꼴) 패턴이 성립합니다',
      '   · **코드 규칙 BLOCK** (완결성 최대, 코드로만) — 즉시 거절이라 되돌릴 사람이 없으므로',
      '     평가셋에서 **오탐 0 이 측정**돼야 합니다. 넓으면 정상 리포트가 사람 확인 없이 죽습니다',
      '4. **관할 재검토 — 형태 매칭인가, 의미 추론(IRIS)인가** — 위 사다리와 별개의 축입니다.',
      '   같은 뜻이 늘 다른 꼴로 오면(패러프레이즈) 사다리 어느 눈금도 못 잡습니다 — 그때는',
      '   IRIS 관할(졸업)입니다. 반대로 이 건이 **IRIS 가 맡던 것을 놓친 것**(졸업 이력 있는',
      '   표현·IRIS 미탐)이면 **졸업 강등**을 논의해 주세요: 형태가 굳어 있으면 위 사다리의',
      '   어느 눈금으로 내릴지(재활성화=사전 / 규칙 WARN / BLOCK 은 코드로만), 형태가 다양하면',
      '   IRIS 에 남기고 재학습으로 고칠지',
    ],
  };
  if (!v) return rejectLike;
  if (v.verdict === 'REJECTED') return rejectLike;
  if (v.verdict === 'TAKEDOWN') {
    return {
      headline:
        '자동 검수가 통과시킨 것을 사람이 내린 건입니다 — 왜 못 잡았고, 어떻게 잡게 할지 논의해 주세요.',
      points: rejectLike.points,
    };
  }
  if (v.verdict === 'MISSED') {
    // 검수가 통과시켰고 이미 닫힌 뒤 신고로 드러난 미탐 — 처분(철회)만 못 했을 뿐
    // 논의는 TAKEDOWN 과 같다("어떻게 잡게 할지"). caseGuide 에서 빠져 있으면
    // 아래 'APPROVED + null'로 떨어져 "표시 없이 승인"이라는 틀린 머리말이 붙는다
    return {
      headline:
        '자동 검수가 통과시켰고 이미 닫힌 뒤 신고로 드러난 건입니다 — 왜 못 잡았고, 어떻게 잡게 할지 논의해 주세요.',
      points: rejectLike.points,
    };
  }
  if (v.verdict === 'KEPT') {
    return {
      headline: '신고가 들어왔지만 사람은 게시를 유지한 건입니다 — 유의할 점만 짚어 주세요.',
      points: [
        '1. **왜 유지했나** — 신고 사유가 있었는데 사람이 문제없다고 본 근거 (본문의 문맥)',
        '2. **유의점** — 경계에 가까운 표현이 있다면, 앞으로 비슷한 글에서 무엇을 더 볼지',
        '3. 자동 검수가 이런 정상 표현을 **오탐하지 않도록** 재학습에 참고할 점이 있는지',
      ],
    };
  }
  // APPROVED
  if (v.findingsValid === true) {
    return {
      headline:
        '지적은 타당했지만 사람이 게시를 승인한 건입니다 — 심각도 조정(재학습)을 논의해 주세요.',
      points: [
        '1. **왜 경미한가** — 지적 자체는 맞는데 게시를 막을 정도는 아니라고 본 근거 (승인 사유 참고)',
        '2. **심각도 조정** — 이 문맥이라면 자동 검수도 BLOCK 이 아니라 통과/약하게 봐야 하나.',
        '   IRIS 가 이런 문맥을 과하게 잡지 않도록 배워야 할 점',
        '3. 규칙이 이 문맥을 못 가려 잡은 것이면, 어떤 조건을 더하면 경미 케이스를 비껴갈지',
      ],
    };
  }
  if (v.findingsValid === false) {
    return {
      headline:
        '사람이 오탐이라고 본 건입니다 — 왜 부적절했고, 규칙·재학습에 어떻게 반영할지 논의해 주세요.',
      points: [
        '1. **왜 오탐인가** — 이 지적이 왜 부적절한지 (오탐 사유 참고). 정상 표현이 걸린 자리',
        '2. **규칙 점검** — 규칙(코드)이 잡은 것이면, 어떤 문맥 조건을 더해야 이 정상 표현을 비껴갈지',
        '3. **IRIS 재학습** — IRIS 가 잡은 것이면, 이 정상 표현을 **오탐하지 않게**(하드 네거티브)',
        '   배우게 할 점',
      ],
    };
  }
  // APPROVED + null(표시하지 않고 승인) — 원칙적으로 질문지가 안 뜨지만, 떠도 무해하게
  return {
    headline: '사람이 표시 없이 승인한 건입니다 — 특별히 논의할 것이 없으면 넘어가도 됩니다.',
    points: rejectLike.points,
  };
}

/**
 * 논의 + 결론 형식 — **케이스별 논의 방향(caseGuide) + 재학습에 쓸 결론.**
 *
 * ⚠ 결론 JSON 형식은 **`parseTeacherAnswer` 가 읽는 그대로**여야 한다 (`labels` +
 * `지적:`). 여기서 형식을 바꾸면 답이 파싱되지 않아 재학습 라벨이 하나도 안 쌓인다 —
 * 이 자료를 만든 목적(재학습)이 조용히 사라진다. 문구만 '판정'에서 '재학습 라벨'로 바꾼다.
 */
function discussionFormat(packId: string, verdict: HumanVerdict | null): string[] {
  return [
    '## 논의해 주세요 (자유 서술)',
    '',
    ...caseGuide(verdict).points,
    '',
    '## 결론 요약 (마지막에 이 형식으로 — IRIS 재학습 라벨로 씁니다)',
    '',
    'JSONL 한 줄. 위반 유형이 없다고 보면 `labels`는 빈 배열입니다.',
    '```',
    `{"id":"${packId}","labels":["PROFIT_GUARANTEE"]}`,
    '```',
    `허용 라벨: ${STUDENT_LABELS.join(' · ')}`,
    '',
    '**`labels`가 빈 배열이면 아래 한 줄을 반드시 덧붙여 주세요:**',
    '```',
    '지적: 타당   ← 자동 검수 지적은 옳았으나 게시를 막을 정도는 아니다 (경미)',
    '지적: 과함   ← 자동 검수가 애초에 잘못 잡았다 (오탐)',
    '```',
    '이 한 줄이 **규칙을 고칠 일**과 **심각도를 고칠 일**을 가릅니다. 없으면 재학습에',
    '기록되지 않습니다.',
    '',
    '위 결론은 재학습용 라벨일 뿐이고, 사다리 이동(학습 표현 등록·승격·졸업·졸업 강등 —',
    '위 3·4번)은 창업자가 이 논의를 읽고 코드로 판단합니다 — JSON 에 넣지 마세요.',
  ];
}

// 목표가 → 등락률 환산은 **점수 계산이 쓰는 함수 그대로** 쓴다. 여기서 따로 계산하면
// 교사가 보는 눈금과 실제 수익성 구간이 어긋난다 (`buildUserMessage` 의 크기 판정 눈금이
// 이 값으로 구간을 고른다)
function cardMagnitude(
  card: { targetType: string; targetValue: number; basePrice: number | null } | null,
): number | null {
  if (!card) return null;
  if (card.targetType === 'RETURN_PCT') return card.targetValue;
  if (card.basePrice == null || card.basePrice <= 0) return null;
  return targetPriceToMagnitudePct(card.targetValue, card.basePrice);
}

function parseFindings(json: string): Finding[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? (v as Finding[]) : [];
  } catch {
    return [];
  }
}
