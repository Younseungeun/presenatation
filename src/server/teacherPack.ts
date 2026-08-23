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

  return {
    ...assembleTeacherPack({
      packId: teacherPackId(review.id),
      input,
      findings: parseFindings(review.findingsJson),
      corrections: deps.corrections,
    }),
    reportTitle: r.title,
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
    '# 컴플라이언스 검수 판정 요청',
    '',
    '아래 <규정>에 따라 항목 1건을 판정해 주세요. 이 요청은 운영 중인 검수기의 2차 단계를',
    '사람이 대신 나르는 것이라, **운영에 쓰이는 규정문 그대로** 싣습니다.',
    '',
    ...answerFormat(args.packId),
    '',
    '---',
    '',
    `<규정>\n${SYSTEM_PROMPT}\n</규정>`,
    '',
    '---',
    '',
    ...firstTierBlock(args.findings),
    '',
    '---',
    '',
    `## 항목  [${args.packId}]`,
    '',
    body,
    '',
  ].join('\n');

  // 무결성 머리글은 **본문이 확정된 뒤에** 붙인다 — 자기 자신을 세면 값이 안 맞는다
  return { text: withIntegrityHeader(text), packId: args.packId };
}

/**
 * **이전 대화의 기준을 폐기시킨다** (18차 V-6).
 *
 * 자동 2차는 매 건이 독립 요청이라 이 문제가 원리적으로 없었다. 사람이 나르면 한
 * 대화창에서 보류 건을 연속으로 묻게 되고, 앞 건의 판정이 뒤 건을 민다.
 *
 * 코드가 할 수 있는 것은 이 문구뿐이다 — 운영자가 새 대화를 여는지는 코드가 모른다.
 * 그래서 화면이 체크박스로 마찰을 만들고(AskTeacher), 답 파싱은 id 를 대조해
 * **앞 건의 답을 복사한 경우**를 잡는다(teacherAnswer.parseTeacherAnswer).
 * 세 겹 중 어느 하나도 혼자서는 못 막는다.
 */
function contextReset(): string[] {
  return [
    '> **이전 대화의 모든 맥락과 기준을 폐기하고, 오직 아래 문서만 독립적으로 판정하세요.**',
    '> 같은 창에서 앞서 판정한 건이 있더라도 그 판단·그때 세운 기준·그때의 엄격도를',
    '> 이 건에 옮기지 마세요. 앞 건과의 일관성보다 **이 건 단독의 정확성**이 우선입니다.',
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
  if (findings.length === 0) return ['## 1차 규칙이 이미 짚은 것', '', '(1차 소견 없음)'];

  const line = (f: Finding) =>
    `- [${RISK_CATEGORY_LABEL[f.category] ?? f.category}] "${f.quote}"`;
  const open = findings.filter((f) => answerable(f.category));
  const context = findings.filter((f) => !answerable(f.category));

  const out = ['## 1차 규칙이 이미 짚은 것 (참고 — 정답이 아닙니다)', ''];
  out.push(open.length > 0 ? open.map(line).join('\n') : '(답할 수 있는 유형의 소견 없음)');

  if (context.length > 0) {
    out.push(
      '',
      '### 읽기 전용 문맥 — 이 소견은 **답에 쓰지 마세요**',
      '',
      '아래는 종목 데이터로 결정되는 유형이라 규칙이 이미 확정했고, 답 형식의 라벨 공간',
      '밖입니다. **이 문서가 왜 보류됐는지 알려 드리려고** 싣습니다 — 다른 위반을 찾지',
      '못했다면 빈 배열로 두세요. 이것 때문에 없는 위반을 만들어 내지 마세요.',
      '',
      context.map(line).join('\n'),
    );
  }
  return out;
}

/**
 * 답 형식 — **`지적:` 한 줄이 오탐과 경미를 가른다** (18차 V-3).
 *
 * `labels: []` 하나로는 "애초에 잘못 잡았다(오탐 → 규칙을 고쳐야 함)"와 "지적은 맞는데
 * 게시를 막을 정도는 아니다(경미 → 심각도를 고쳐야 함)"가 접힌다. 11차 K-1이 그 둘을
 * 접었을 때 무슨 일이 나는지 실측했다 — 25건 중 6건이면 학생 모델이 영구히 꺼진다.
 */
function answerFormat(packId: string): string[] {
  return [
    '## 출력 형식 (반드시 이대로)',
    '',
    'JSONL 한 줄. 위반이 없으면 `labels`는 빈 배열입니다.',
    '```',
    `{"id":"${packId}","labels":["PROFIT_GUARANTEE"]}`,
    '```',
    `허용 라벨: ${STUDENT_LABELS.join(' · ')}`,
    '',
    '**`labels`가 빈 배열이면 아래 한 줄을 반드시 덧붙여 주세요:**',
    '```',
    '지적: 타당   ← 1차 지적은 옳았으나 게시를 막을 정도는 아니다',
    '지적: 과함   ← 1차가 애초에 잘못 잡았다',
    '```',
    '이 한 줄이 **규칙을 고칠 일**과 **심각도를 고칠 일**을 가릅니다. 없으면 그 답은',
    '기록되지 않고 운영자가 손으로 다시 골라야 합니다.',
    '',
    '**심각도는 받지 않습니다** — 소견은 BLOCK이든 WARN이든 처리가 같고(보류), 유형만 씁니다.',
    '판정 뒤에 왜 그렇게 봤는지 두세 줄로 덧붙여 주세요 — 운영자가 최종 결정에 씁니다.',
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
