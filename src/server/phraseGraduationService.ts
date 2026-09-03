import type { PrismaClient } from '@prisma/client';
import { isStudentLabel } from '@/domain/studentText';
import {
  applyRules,
  screeningText,
  type Finding,
  type RiskCategory,
  type ScreeningInput,
} from '@/domain/compliance';
import { charBigramJaccard } from '@/domain/textSimilarity';
import { parseProbe, probeFailed } from '@/domain/formalizationProbe';
import {
  ApprovalError,
  consumeApproval,
  consumeOperatorRecheck,
  isSoloOperatorMode,
  requestApproval,
} from './operatorApprovalService';

// **사전 항목의 졸업** (20차 X-5 — 승격은 금지, 나가는 길은 이것뿐).
//
// ── 재검토 개시 조건 (2026-08-27 창업자 확정 — 회신 21호 답장) ─────────
// X-2(승격 금지)는 유지한다. 단 **보류 큐 유입이 7일 연속 하루 30건을 초과**하면
// (운영자 1인 기준 판정 노동이 실질 부담이 되는 선 — 첫 분기 실측으로 재보정),
// 그때 5조건(걸림 30·정탐 100%·경과 30일·리서처 5명·부정 문맥 0) 통과 표현에 한한
// BLOCK 코드 이식을 **외부 검토 안건으로** 올린다. 그 전에는 이식 없음.
//
// ── 두 길이 있었고 하나를 닫았다 ─────────────────────────────────────
// 검증된 사전 항목의 출구로 "코드 승격(BLOCK 권한)"과 "졸업(학생 위임)"이 경쟁했다.
// 20차 X-2 판정: **승격 금지.** 코드 규칙은 비의미적 형태(전화번호·기호 패턴)만
// BLOCK 해야 하고, 의미를 가진 낱말은 아무리 정확도가 높아도 코드로 굳히지 않는다 —
// 의미의 관할은 학생이다. 그래서 사전 항목의 유일한 출구가 졸업이다.
//
// ── 졸업은 자동 증명이 아니다 ────────────────────────────────────────
// "학생이 이 표현을 잡는다"를 변형 자동 생성으로 증명하려는 안은 동어반복으로
// 기각됐다(생성기가 규칙 6층과 같은 논리면 규칙이 이미 잡는 것만 시험한다).
// 졸업은 **운영자의 수동 판단**이고, 그 판단의 대가로 대비쌍을 남긴다:
//
//   위반 3문장 — 학생이 반드시 잡아야 하는 것
//   정상 3문장 — 학생이 잡으면 안 되는 것 (같은 표현이 정상 맥락에 든 문장)
//
// 이 대비쌍이 **영구 회귀 시험셋**이 된다. 이후 모든 재학습에서 여기 오답이 나면
// 채택을 막는다 — 졸업시킨 표현을 학생이 잊는 것(치명적 망각)이 그 표현을 무방비로
// 만드는 유일한 경로라서다.

export class GraduationError extends Error {
  constructor(
    message: string,
    /**
     * RECHECK_REQUIRED = 1인 운영 모드 — 화면이 지문·얼굴 확인(performOperatorRecheck)을
     * 띄우고 recheckToken 을 실어 재시도한다.
     * APPROVAL_PENDING = 다인 모드 — 요청을 올리고 멈춘 상태. **실패가 아니라 절차의
     * 절반**이라 화면이 오류 색으로 그리면 안 된다 (payoutAccountService 와 같은 계약 —
     * 4회차 §1에서 격리만 이 코드가 빠져 있던 것을 맞춤)
     */
    readonly code?: 'APPROVAL_PENDING' | 'RECHECK_REQUIRED',
  ) {
    super(message);
    this.name = 'GraduationError';
  }
}

/** @근거 설계 — 20차 X-5 검토 확정값: 위반 3 / 정상 3 이 대비쌍의 최소 구성 */
export const GRADUATION_MIN_CASES_PER_SIDE = 3;

/**
 * @근거 시뮬 — scripts/probePairDiversity.ts (2026-08-21, 합성 390건 실측):
 * 같은 의도를 자연스럽게 다르게 쓴 3문장의 쌍별 자카드(글자 2-gram)는 최대 0.323,
 * 같은 문장에서 낱말 하나만 바꾼 복붙 쌍은 최소 0.400 — **두 분포가 겹치지 않는다.**
 * 컷오프를 그 사이에 두고 `>=` 로 거절한다: 자연 쌍 오차단 0%, 복붙 쌍 통과 0%.
 * 검토 제안값 0.5 대신 0.4 인 이유 — 오차단은 운영자가 다시 쓰면 되지만(비용 작고
 * 보임) 복붙 통과는 회귀셋을 조용히 약화시킨다. 실패가 보이는 쪽으로 눕힌다.
 *
 * ⚠ 형태의 거리지 뜻의 거리가 아니다 (21차 gap 17형 함정) — 뜻이 한 점에 뭉친
 * 3문장은 통과한다. 그 잔여는 운영자 지침의 몫이다.
 */
export const GRADUATION_MAX_PAIR_SIMILARITY = 0.4;

/**
 * @근거 설계 — 졸업 사유("공식화를 어떻게 시도했고 왜 안 됐나")의 최소 길이 (2026-09-01
 * 창업자 확정). 관문이 "코드로 못 적는가"를 한 번도 묻지 않아 늘 같은 꼴 "원금 보장"도
 * 졸업이 통과됐다(탐침 실측). 20자는 "정규식 X를 써 봤는데 Y가 걸려서"가 겨우 들어가는
 * 길이 — 한 낱말로 때우는 것만 막고, 진짜 사유는 어차피 더 길다. 비용이 곧 필터다
 */
export const GRADUATION_REASON_MIN = 20;

/** @근거 설계 — 21차 Y-3 검토 확정: 졸업 직후 7일간 그 표현을 감시 전용으로 계속 돈다 */
export const GRADUATION_WATCH_DAYS = 7;

export interface GraduationCaseInput {
  text: string;
  expectViolation: boolean;
  /** 위반 쪽만: 기대 유형 (학생 라벨 공간 안이어야 한다) */
  category?: RiskCategory;
}

/**
 * 사전 항목을 졸업시킨다 — 항목을 끄고, 대비쌍을 영구 회귀 시험셋에 넣는다.
 *
 * **원자적이다**: 회귀 케이스가 저장되지 않았는데 항목만 꺼지면 그 표현이 아무 방어
 * 없이 무방비가 된다. 반대로 케이스만 쌓이고 항목이 안 꺼지면 무해하다 — 순서가 아니라
 * 트랜잭션으로 묶는 이유다.
 */
export async function graduatePhrase(
  prisma: PrismaClient,
  input: {
    phraseId: string;
    cases: GraduationCaseInput[];
    operatorUserId: string;
    /** 공식화 시도 메모 — 선택 (12차 C-4: 잠금은 샌드박스 기록이 맡고, 사유는 메모로 강등) */
    reason?: string;
  },
): Promise<{ registered: number }> {
  const phrase = await prisma.learnedPhrase.findUnique({ where: { id: input.phraseId } });
  if (!phrase) throw new GraduationError('사전 항목을 찾을 수 없습니다');
  if (!phrase.active) throw new GraduationError('이미 꺼진 항목입니다');

  const violations = input.cases.filter((c) => c.expectViolation);
  const normals = input.cases.filter((c) => !c.expectViolation);
  if (violations.length < GRADUATION_MIN_CASES_PER_SIDE || normals.length < GRADUATION_MIN_CASES_PER_SIDE) {
    throw new GraduationError(
      `대비쌍이 부족합니다 — 위반 ${GRADUATION_MIN_CASES_PER_SIDE}문장 · 정상 ${GRADUATION_MIN_CASES_PER_SIDE}문장 이상을 직접 써 주세요. ` +
        '이 문장들이 재학습 때마다 학생을 시험합니다 — 여기서 오답이 나면 그 모델은 배포되지 않습니다.',
    );
  }

  const normalizedTarget = phrase.normalized;
  for (const c of input.cases) {
    const text = c.text.trim();
    if (text.length < 10) {
      throw new GraduationError(`문장이 너무 짧습니다: "${text}" — 실제 리포트 문장처럼 써 주세요`);
    }
    // 위반 케이스는 라벨 공간 검사 — 학생이 낼 수 없는 유형을 기대하면 영원히 빨간불이다
    if (c.expectViolation) {
      if (!c.category || !isStudentLabel(c.category)) {
        throw new GraduationError(
          `위반 문장에는 학생 라벨 공간 안의 유형이 필요합니다: "${text.slice(0, 30)}"`,
        );
      }
    }
    void normalizedTarget; // 표현 포함 여부는 강제하지 않는다 — 패러프레이즈 케이스가 더 값지다
  }

  // 복붙 감지 (21차 Y-3) — 같은 문장에서 낱말만 바꾼 3문장은 명목 3, 실질 1이다.
  // 회귀셋의 실질 문항 수가 릴리스 게이트의 폭이므로 여기서 걸러야 한다
  for (const side of [violations, normals]) {
    for (let i = 0; i < side.length; i++) {
      for (let j = i + 1; j < side.length; j++) {
        const sim = charBigramJaccard(side[i].text, side[j].text);
        if (sim >= GRADUATION_MAX_PAIR_SIMILARITY) {
          throw new GraduationError(
            `두 문장이 너무 닮았습니다 (유사도 ${(sim * 100).toFixed(0)}%) — ` +
              `"${side[i].text.slice(0, 20)}…" / "${side[j].text.slice(0, 20)}…". ` +
              '낱말만 바꾼 문장은 회귀 시험을 넓히지 못합니다. 상황이 다른 문장으로 다시 써 주세요.',
          );
        }
      }
    }
  }

  // ── "코드로 못 적는가"를 묻는 관문 (2026-09-01 창업자 확정) ──────────────────────
  // 위 검사는 전부 **회귀셋의 품질**(수·길이·라벨·복붙)이라 "넘겨도 ARGOS 가 안전하게
  // 시험받나"만 지킨다. "넘겨야 하나"는 아무도 안 물어, 늘 같은 꼴 "원금 보장"도 졸업이
  // 통과됐다(탐침 실측). 둘을 요구한다 — 막지 않고 건너뛰기를 비싸게 만드는 쪽으로:
  //   ① 항목 질문지를 한 번은 뽑았어야 한다 (공식화를 검토했다는 도장 — 클릭 한 번)
  //   ② 공식화 시도와 실패 이유를 적어야 한다 (한 낱말로 못 때우는 길이)
  // 형태 굳음·ARGOS 동반 검출 0 은 **경고만** 한다(화면) — 사람의 확신에 여지를 남긴다
  if (!phrase.itemPackAskedAt) {
    throw new GraduationError(
      '항목 질문지를 먼저 뽑아 주세요 — 검출 항목 관리 표의 "항목 질문지 ▾"를 한 번 열면 됩니다. ' +
        '졸업은 "코드로 못 적으니 ARGOS 로"라는 결정이라, 공식화를 검토한 흔적이 있어야 합니다.',
    );
  }
  // ② **공식화 샌드박스에서 실패한 기록** (12차 검토 C-4 채택). 20자 사유는 1인 운영에서
  // "코드로 짤 수 없음" 같은 보일러플레이트가 된다 — 대신 후보 표현/패턴을 실제로 돌린
  // 숫자를 본다: 정탐을 놓쳤거나(tpMiss) 정상 문장을 잡았으면(normalHit) 공식화 실패 = 졸업.
  // 둘 다 0 이면 공식화가 됐다는 뜻이라 졸업이 아니라 규칙 승격감이다
  const probe = parseProbe(phrase.formalizeProbeJson);
  if (!probe) {
    throw new GraduationError(
      '공식화 샌드박스를 먼저 돌려 주세요 — 후보 표현(또는 패턴)을 넣고 "돌려보기"를 누르면 ' +
        '이 항목이 잡은 문장과 대조군에 대한 정탐/오탐이 나옵니다. 그 기록이 있어야 졸업할 수 있습니다.',
    );
  }
  if (!probeFailed(probe)) {
    throw new GraduationError(
      `마지막 샌드박스 시도("${probe.pattern}")가 정탐 ${probe.tpHit}/${probe.tpTotal}을 다 잡고 정상 문장 ${probe.normalTotal}건을 하나도 안 잡았습니다 — ` +
        '공식화가 됐다는 뜻입니다. 졸업이 아니라 규칙 승격 후보입니다. 못 잡는 꼴이 있다면 그 문장으로 다시 돌려 주세요.',
    );
  }
  const reason = (input.reason ?? '').trim();

  await prisma.$transaction([
    prisma.regressionCase.createMany({
      data: input.cases.map((c) => ({
        phraseId: phrase.id,
        text: c.text.trim(),
        expectViolation: c.expectViolation,
        category: c.expectViolation ? (c.category as string) : null,
        createdBy: input.operatorUserId,
      })),
    }),
    prisma.learnedPhrase.update({
      where: { id: phrase.id },
      // graduatedAt 이 관찰 창(7일)의 기준점이다 — active=false 만으로는
      // 졸업과 수동 비활성화(오탐 항목)를 못 가른다
      data: { active: false, graduatedAt: new Date(), graduationReason: reason || null },
    }),
  ]);
  return { registered: input.cases.length };
}

/**
 * 회귀 시험셋 전체 — 재학습 채택 판단(eval:student)이 읽는다.
 *
 * **학습 자료로 절대 나가면 안 된다** (17차 채점지 원칙). trainExport 계열이 이 표를
 * 읽지 않는 것이 그 격리이고, 시험이 그 사실을 붙잡아야 한다.
 */
export async function getRegressionCases(prisma: PrismaClient) {
  // 격리된 문항은 게이트에서 빠진다 — 다만 행은 영구히 남아 "언제 누가 왜 뺐는가"에 답한다
  return prisma.regressionCase.findMany({
    where: { quarantinedAt: null },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * 회귀 문항 격리 (21차 Y-3 검토 확정) — 수정은 영구 금지, 삭제 대신 격리, 격리에는
 * **운영자 2인 승인**이 필요하다.
 *
 * 회귀셋을 혼자 편집할 수 있으면 릴리스 압박과 함께 "학생이 틀리는 문항 지우기"
 * 유혹이 온다. 승인서(REGRESSION_CASE_QUARANTINE)는 1회용이라 한 승인으로 한 문항만
 * 격리된다. 1인 운영 모드에서는 승인 자리가 생체 재확인으로 대체된다(기존 규칙 그대로).
 */
export async function quarantineRegressionCase(
  prisma: PrismaClient,
  input: { caseId: string; operatorUserId: string; reason: string; recheckToken?: string },
  now = new Date(),
): Promise<void> {
  const row = await prisma.regressionCase.findUnique({ where: { id: input.caseId } });
  if (!row) throw new GraduationError('회귀 문항을 찾을 수 없습니다');
  if (row.quarantinedAt) throw new GraduationError('이미 격리된 문항입니다');
  if (!input.reason.trim()) {
    throw new GraduationError('격리 사유가 필요합니다 — 이 문항이 왜 잘못 쓰였는지 적어 주세요');
  }
  // ── 승인 관문 — 1인 갈림길 포함 (관리자 앱 운영 체제 안내 Q1로 붙임) ──
  // 처음 구현은 consumeApproval 만 불렀다: 주석에는 "1인 모드에서는 생체 재확인이
  // 대체한다"고 적어 놓고 갈림길을 코드에 안 넣어, **운영자가 1명인 현실에서는
  // 아무도 지나갈 수 없는 문**이었다 — 승인을 올릴 상대도, 지문을 댈 자리도 없었다.
  // 표준 모양(payoutAccountService §동결 해제)을 그대로 따른다: 승인서가 있으면 우선,
  // 없으면 1인=재확인 표 소비 / 다인=승인 요청을 대신 올리고 멈춤.
  try {
    await consumeApproval(prisma, { action: 'REGRESSION_CASE_QUARANTINE', targetId: input.caseId }, now);
  } catch (e) {
    if (!(e instanceof ApprovalError)) throw e;
    if (await isSoloOperatorMode(prisma)) {
      try {
        await consumeOperatorRecheck(prisma, input.operatorUserId, input.recheckToken, now);
      } catch (re) {
        if (!(re instanceof ApprovalError)) throw re;
        throw new GraduationError(re.message, 'RECHECK_REQUIRED');
      }
    } else {
      await requestApproval(
        prisma,
        {
          action: 'REGRESSION_CASE_QUARANTINE',
          targetId: input.caseId,
          summary: `회귀 문항 격리 — "${row.text.slice(0, 40)}"`,
          requestedBy: input.operatorUserId,
          reason: input.reason.trim(),
        },
        now,
      );
      throw new GraduationError(
        '승인 요청을 올렸습니다 — 다른 운영자의 승인 후 다시 실행하세요.',
        'APPROVAL_PENDING',
      );
    }
  }
  await prisma.regressionCase.update({
    where: { id: input.caseId },
    data: {
      quarantinedAt: now,
      quarantinedBy: input.operatorUserId,
      quarantineReason: input.reason.trim(),
    },
  });
}

/**
 * 졸업 관찰 기록 (21차 Y-3) — 졸업 직후 7일간 그 표현을 **감시 전용**으로 계속 돈다.
 *
 * 졸업 직후가 가장 위험한 순간이다: 사전 보호가 꺼지고 학생만 남는데, 뚫린 것을
 * 알아채는 경로가 미탐 신고뿐이면 운영자가 자기 오류를 자기가 발견해야 한다.
 * 그래서 졸업한 표현을 같은 규칙 엔진으로 계속 돌리되 **소견은 내지 않는다** —
 * 걸리면 여기 기록만 하고, 학생이 같은 유형을 잡았는지를 함께 남긴다.
 * studentFlagged=false 가 쌓이면 졸업이 성급했다는 증거다 (재활성화 판단의 재료).
 *
 * screenAndRecord 가 커밋 뒤에 부른다 — 실패는 결측이지 사고가 아니다.
 */
export async function recordGraduationWatch(
  prisma: PrismaClient,
  complianceReviewId: string,
  input: ScreeningInput,
  findings: Finding[],
  knownNames: ReadonlySet<string> | undefined,
  now = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - GRADUATION_WATCH_DAYS * 24 * 60 * 60 * 1000);
  const graduated = await prisma.learnedPhrase.findMany({
    where: { active: false, graduatedAt: { gte: cutoff } },
    select: { id: true, phrase: true, normalized: true, category: true, note: true, phoneticEligible: true },
  });
  if (graduated.length === 0) return;

  // 운영과 같은 엔진으로 잰다 — 감시가 다른 매처를 쓰면 "사전이 잡던 것"과 어긋난다
  const watchFindings = applyRules(input, {
    knownNames,
    phrases: graduated.map((p) => ({
      id: p.id,
      phrase: p.phrase,
      normalized: p.normalized,
      category: p.category as RiskCategory,
      note: p.note,
      phoneticEligible: p.phoneticEligible,
    })),
  }).filter((f) => f.source === 'learned' && f.phraseId);
  if (watchFindings.length === 0) return;

  // 학생이 같은 유형을 잡았는가 — 라이브면 본 소견에, 그림자면 그림자 표에 있다
  const studentCategories = new Set(
    findings.filter((f) => f.source === 'student').map((f) => f.category),
  );
  if (studentCategories.size === 0) {
    const shadow = await prisma.shadowComplianceReview.findFirst({
      where: { complianceReviewId },
      orderBy: { createdAt: 'desc' },
    });
    if (shadow) {
      try {
        for (const f of JSON.parse(shadow.findingsJson) as Finding[]) {
          studentCategories.add(f.category);
        }
      } catch {
        // 깨진 그림자 기록은 "학생 침묵"으로 읽는다 — 감시가 관대해지는 쪽이 안전하다
      }
    }
  }

  // 표면형 = 실제로 걸린 구간 그대로 (span 이 가리키는 원문 조각). 졸업 강등의 증거다 —
  // 굳은 형태로 반복 출현하면 형태 매칭이 이 표현을 완전히 잡는다는 실측이 된다.
  // quote 는 앞뒤 문맥이 붙은 인용문이라 표면형 집계에 못 쓴다(같은 매칭도 문맥마다 다르다)
  const text = screeningText(input);
  const seen = new Set<string>();
  const data = watchFindings.flatMap((f) => {
    const key = `${f.phraseId}:${f.category}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        phraseId: f.phraseId as string,
        complianceReviewId,
        category: f.category,
        studentFlagged: studentCategories.has(f.category),
        matchedSurface: f.span ? text.slice(f.span[0], f.span[1]) : null,
        createdAt: now,
      },
    ];
  });
  if (data.length > 0) await prisma.graduationWatchHit.createMany({ data });
}

/**
 * 졸업 관찰 화면의 재료 — 최근 7일 내 졸업한 항목과 그 관찰 기록.
 * 관리자 앱이 그린다. 그림자 판정 자체는 여기 실리지 않는다 (X-6 비노출 유지 —
 * 실리는 것은 "졸업한 표현이 나타났고 학생이 잡았는가"라는 집계 사실뿐이다).
 */
export async function getGraduationWatch(prisma: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - GRADUATION_WATCH_DAYS * 24 * 60 * 60 * 1000);
  const phrases = await prisma.learnedPhrase.findMany({
    where: { active: false, graduatedAt: { gte: cutoff } },
    select: { id: true, phrase: true, category: true, graduatedAt: true },
    orderBy: { graduatedAt: 'desc' },
  });
  if (phrases.length === 0) return [];
  const hits = await prisma.graduationWatchHit.findMany({
    where: { phraseId: { in: phrases.map((p) => p.id) } },
    orderBy: { createdAt: 'desc' },
  });
  // 관찰이 붙은 검수 건의 운영자 판정 대조 — 복귀 추천(detectionLadder UNGRADUATE)의
  // 트리거는 미탐 총수가 아니라 **미탐 ∩ 확정 위반**(missTruePos)이다. 관찰 상자가
  // 총수만 보여주면 운영자는 사다리 표와 다른 숫자를 두 화면에서 읽게 된다 —
  // 분류 기준은 detectionLadderService 의 watchVerdicts 와 똑같이 둔다.
  const reviewIds = [...new Set(hits.map((h) => h.complianceReviewId))];
  const verdicts = new Map<string, { tp: boolean; fp: boolean }>();
  if (reviewIds.length > 0) {
    const rs = await prisma.complianceReview.findMany({
      where: { id: { in: reviewIds } },
      select: { id: true, operatorVerdict: true, aiFindingsValid: true },
    });
    for (const r of rs) {
      verdicts.set(r.id, {
        tp: r.operatorVerdict === 'REJECTED' || r.operatorVerdict === 'TAKEDOWN',
        fp: r.operatorVerdict === 'APPROVED' && r.aiFindingsValid === false,
      });
    }
  }
  return phrases.map((p) => {
    const mine = hits.filter((h) => h.phraseId === p.id);
    return {
      ...p,
      hitCount: mine.length,
      studentMissCount: mine.filter((h) => !h.studentFlagged).length,
      // 미탐 중 사람이 위반으로 확정한 건 — 복귀의 실증. 아직 판정 안 된 건은 어느 쪽도 아니다
      missTruePos: mine.filter(
        (h) => !h.studentFlagged && verdicts.get(h.complianceReviewId)?.tp,
      ).length,
      // 그림자 오탐(관찰이 잡았는데 사람은 "오탐 승인") — 하나라도 있으면 복귀 추천이 죽는다
      shadowFalsePos: mine.filter((h) => verdicts.get(h.complianceReviewId)?.fp).length,
      lastHitAt: mine[0]?.createdAt ?? null,
    };
  });
}

/**
 * 미탐 재활성화 — 졸업했던 표현이 실운영에서 뚫렸을 때 (20차 X-5).
 *
 * **자동이 아니라 사람이 누른다.** 자동 재활성화는 미탐 신고 하나로 사전이 스스로
 * 자라는 경로가 되고, 그 신고 자체가 오판일 수 있다. 다만 화면이 "이 미탐의 표현은
 * 졸업 이력이 있다"를 보여줘 운영자가 한 클릭으로 되살릴 수 있게 한다.
 */
export async function reactivatePhrase(prisma: PrismaClient, phraseId: string): Promise<void> {
  await prisma.learnedPhrase.update({ where: { id: phraseId }, data: { active: true } });
}
