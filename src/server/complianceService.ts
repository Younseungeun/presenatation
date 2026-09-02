import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  createStudentClientFromEnv,
  studentMode,
  type StudentClient,
  type StudentMode,
} from '@/infra/compliance/studentClient';
import { ROLLBACK_WINDOW, studentRollbackStatus } from '@/domain/studentRollback';
import { evaluateAutoShadow, isAutoShadowed } from './studentAutoShadow';
import { getKnownInstrumentNames } from './instrumentNames';
import { notifyOperators } from './opsAlert';
import { recordShadowJudgment } from './shadowScreeningService';
import {
  applyRules,
  decide,
  findingMessages,
  mergeFindings,
  negationAfter,
  resolveAction,
  screeningText,
  type ComplianceDecision,
  type ComplianceResult,
  type Finding,
  type RiskCategory,
  type ScreeningInput,
} from '@/domain/compliance';
import {
  calibrationExamples,
  summarizeAccuracy,
  type CalibrationExample,
  type LabeledReview,
  type OperatorVerdict,
} from '@/domain/screeningAccuracy';
import type { LearnedPhrase } from '@/domain/learnedPhrases';
import {
  deliberationRatio,
  type ComplianceScreener,
  type ScreeningOutput,
  type ScreeningUsage,
} from '@/infra/compliance/screener';
import { ELAPSED_MEASURE_START } from './decisionSpeedService';
import { buildJudgmentWrites } from './judgmentWriter';
import { getActiveLearnedPhrases } from './learnedPhraseService';
import { getStudentBypass, recordStudentOutage } from './studentValveService';
import { recordGraduationWatch } from './phraseGraduationService';

// 게시 전 컴플라이언스 검수 실행·기록.
//
// 순서: 결정적 규칙 → (규칙이 차단하지 않았으면) AI 검수 → 병합 → 결정 → 기록.
// 규칙이 이미 BLOCK을 냈으면 AI를 호출하지 않는다 (결과가 바뀌지 않는데 비용·지연만 든다).

/**
 * 학습 표현 hit 의 매칭 스냅샷 (회신 20호 요청 1) — 소견의 span·quote 로 계산한다.
 *
 * span 은 screeningText(제목⏎요약⏎본문) 기준 위치다. span 이 있으면 그 자리에서
 *   · surface  = 매칭 원문 조각 (정규화 전 — 회피 표기가 보인다)
 *   · sentence = ±60 자 문맥 (공백 정리 + … 표시)
 *   · negation = negationAfter (STRONG/WEAK/null. STRONG 은 소견 자체가 억제돼 여기 안 온다)
 * span 이 없는 옛/일부 소견은 quote 를 문맥으로만 남기고 나머지는 비운다(지어내지 않는다).
 */
function phraseHitSnapshot(
  finding: Finding,
  text: string,
): { sentence: string | null; surface: string | null; negation: string | null } {
  const span = finding.span;
  if (!span) return { sentence: finding.quote || null, surface: null, negation: null };
  const [start, end] = span;
  const surface = text.slice(start, end);
  const from = Math.max(0, start - 60);
  const to = Math.min(text.length, end + 60);
  const sentence =
    (from > 0 ? '…' : '') +
    text.slice(from, to).replace(/\s+/g, ' ').trim() +
    (to < text.length ? '…' : '');
  return { sentence, surface, negation: negationAfter(text, end) };
}

/**
 * 검수 실행에 붙는 운영 데이터.
 * 둘 다 운영자의 판정에서 나온다 — 이 시스템이 시간이 지날수록 나아지는 두 통로다.
 */
export interface ScreeningContext {
  /** AI 프롬프트에 붙일 과거 오탐 사례 */
  calibration?: CalibrationExample[];
  /** 운영자가 반려하며 등록한 학습 표현 (규칙과 동등하게 1차에서 적용) */
  phrases?: LearnedPhrase[];
  /**
   * 상장 종목명·티커 (server/instrumentNames.getKnownInstrumentNames).
   * **없으면 표기 회피 탐지가 침묵한다** — 화이트리스트 없이 켜면 정상 종목명이
   * 오탐이 되기 때문이다(13차 P-1 실측: 대조군 8건 중 5건). 배선을 빠뜨려도
   * 코드가 조용히 동작하므로, 시험이 이 자리가 채워지는 것을 강제한다.
   */
  knownNames?: ReadonlySet<string>;
  /**
   * 자체 증류 분류기 (8차 E-6 — 라이브 모드에서만 채워진다).
   *
   * 규칙·학습 표현·의미 검색과 **같은 1차 단계**다. 소견은 항상 WARN이라 즉시 거절을
   * 유발하지 않고, 그래서 이 자리에 있어도 `ruleDecision`(거절 권한)은 건드리지 않는다.
   * 여기가 메우는 자리는 **패러프레이즈**다 — 규칙의 탐지율이 0%인 유일한 칸이고,
   * 학생 단독 66.7%가 그대로 순증이다 (8차 C-1).
   */
  student?: StudentClient;
  /**
   * 라이브 학생이 **있어야 하는데 장애로 빠졌다** (Q0 · 2026-08-21 창업자 확정).
   * resolveLiveStudent 가 판별한다. true 면 runScreening 이 소견과 무관하게
   * UNAVAILABLE 보류를 낸다 — 검수가 가장 약한 순간에 조용히 게시되면 안 된다.
   */
  studentOutage?: boolean;
  /**
   * 장애 우회 밸브가 내려가 있다 (21차 Y-1(b) · studentValveService.getStudentBypass).
   * true 면 장애 보류를 우회해 규칙 단독으로 흐르되, 결과에 VALVE_BYPASS 꼬리표가
   * 영구히 남는다. 밸브는 2시간 뒤 자동 만료 — 조용히 약해진 채 잊히지 않게.
   */
  studentBypass?: boolean;
}

/**
 * **1차 소견 조립 — 이 한 곳에만 있다.**
 *
 * 게시 검수(runScreening)와 작성 중 사전 검사(POST /api/compliance/check)가 같은 함수를
 * 쓴다. 예전에는 두 곳이 각자 조립했는데, 그러면 한쪽에만 탐지기를 더하는 날 화면과
 * 실제 결과가 갈라진다 — 리서처는 "소견 없음"을 보고 제출했다가 보류를 맞는다.
 * **각 파일이 자기 안에서 옳아도 시스템은 틀릴 수 있다**는 것을 8차에 비싸게 배웠고
 * (학습셋 = 채점지), 같은 모양의 위험이 여기 있었다.
 *
 * 네 갈래 전부 **심각도가 WARN**이거나(학습 표현·의미 검색·학생) 코드 규칙이다.
 * 즉시 거절 권한은 코드 규칙에만 있고, 그 판단은 호출자가 `applyRules` 결과로 따로 낸다 —
 * 여기 무엇이 더해져도 새로운 거절이 생기지 않는다.
 */
export async function collectAutoScreenFindings(
  input: ScreeningInput,
  ctx: ScreeningContext = {},
): Promise<{ code: Finding[]; all: Finding[]; studentFailed: boolean }> {
  // **사전은 규칙 엔진의 입력이다** (2026-08-21 창업자 확정 · 20차 구조 개편).
  // 예전에는 matchLearnedPhrases 별도 경로였는데, 그러면 사전 표현이 6층 해석
  // (간격 판별·부정 문맥·종목명 마스킹·음성 변형)을 하나도 못 받는다 — 실측으로
  // 미탐(`원금보쟝`)과 오탐(`복원. 금보장`)이 양방향이었다.
  //
  // 즉시 거절 판단은 여전히 코드 원천만 — `decide` 에 들어가는 심각도에서 사전 원천은
  // 전부 WARN 이라(phraseToRule) 이 합류가 새 거절을 만들 수 없다.
  const codeFindings = applyRules(input, { knownNames: ctx.knownNames, phrases: ctx.phrases });
  // 의미 검색은 걷어냈다 (20차) — 학생과 같은 질문("뜻이 위반인가")의 중복이었고,
  // 임베딩 공급자가 null 이라 실제로 돈 적도 없다. 모듈은 남고 배선만 끊는다.
  //
  // 학생 모델: 규칙이 못 잡는 패러프레이즈를 메운다 (8차 C-1: 0% → 66.7%).
  // 실패해도 여기서는 빈 배열 — 다만 **라이브 모드의 실패는 조용히 넘어가지 않는다**:
  // 호출자(runScreening)가 studentFailed 를 보고 보류로 돌린다 (Q0 · 창업자 확정).
  let studentFailed = false;
  const studentFindings = ctx.student
    ? await ctx.student
        .screen(input)
        .then((o) => {
          if (!o) studentFailed = true;
          return o?.findings ?? [];
        })
        .catch((e) => {
          console.error('학생 모델 검수 실패:', e);
          studentFailed = true;
          return [];
        })
    : [];
  return {
    code: codeFindings,
    all: [...codeFindings, ...studentFindings],
    studentFailed,
  };
}


/**
 * **학생이 지금 실집행에 낄 수 있는가** — 라이브 진입의 유일한 관문.
 *
 * 걸쇠도 `usable()`도 각각 시험이 있지만, 둘을 **어떤 순서로 엮었는가**가 예전에는
 * screenAndRecord 안의 한 줄이라 아무도 붙잡고 있지 않았다. 8차에 비싸게 배운 것이
 * 정확히 그 모양이다 — 각 파일이 자기 안에서 옳아도 시스템은 틀릴 수 있다.
 *
 * 순서에 뜻이 있다:
 *
 * ① **모드** — 환경 변수가 `off`·`shadow`면 여기서 끝. 아무것도 묻지 않는다
 * ② **걸쇠** — 자동 격하가 걸려 있으면 `usable()`을 **부르지도 않는다.**
 *    `STUDENT_MODE=live`보다 걸쇠가 세다: 배포 설정은 "쓰겠다는 의도"이고 걸쇠는
 *    "쓸 수 없다는 관측"이라, 의도가 관측을 덮으면 격하 장치가 재배포 한 번에 지워진다.
 *    사이드카 호출을 아끼는 것은 덤이다 — 격하된 동안에는 물어볼 이유가 없다
 * ③ **지문·카나리아** — 여기까지 와야 사이드카에게 묻는다
 */
export interface LiveStudentResolution {
  /** 라이브로 검수에 참여할 학생. 없으면 undefined */
  client: StudentClient | undefined;
  /**
   * **의도된 끔과 장애를 가른다** (Q0 · 2026-08-21 창업자 확정: 검사기가 죽으면 보류).
   *
   * 네 가지 undefined 가 전부 같은 얼굴이던 것이 구멍이었다 — 라이브 설정인데
   * 사이드카가 죽으면 소견 0건으로 **그냥 게시**됐고 아무도 몰랐다.
   *
   *   mode ≠ live       → 의도된 끔 (규칙 단독 게시가 설계)      outage: false
   *   client 없음        → URL 미설정 = mode 'off' 와 동치        outage: false
   *   자동 격하           → 시스템의 의도된 격하 (성적 근거)        outage: false
   *   usable() 실패      → **장애** — 쓰겠다고 했는데 못 쓴다      outage: true
   */
  outage: boolean;
}

export async function resolveLiveStudent(
  prisma: PrismaClient,
  mode: StudentMode,
  student: StudentClient | null,
): Promise<LiveStudentResolution> {
  if (mode !== 'live' || !student) return { client: undefined, outage: false };
  if (await isAutoShadowed(prisma)) return { client: undefined, outage: false };
  return (await student.usable())
    ? { client: student, outage: false }
    : { client: undefined, outage: true };
}

/**
 * 학생 사이드카의 **가용 상태가 바뀐 순간**에만 운영자에게 알린다 (9차 검토 G-2).
 *
 * 이 설계에서 사이드카 장애는 게시를 막지 않는다 — 학생이 통째로 빠지고 규칙 단독으로
 * 돌아간다. 그래서 아무도 차이를 못 느끼는데 **패러프레이즈 탐지율만 조용히 0%가 된다.**
 * 발견 경로가 없는 실패라 알림이 유일한 눈이다.
 *
 * 실패할 때마다 울리지 않는다(재기동 중 1분마다 울리면 경보 피로다). 울리는 것은
 * 상태가 아니라 **변화**이고, 그 감지는 클라이언트가 한다(상태가 거기 살기 때문).
 *
 * **어떤 실패도 게시를 막지 않는다** — 알림을 못 보내는 것은 사건이 아니라 결측이다.
 */
export async function notifyStudentAvailability(
  prisma: PrismaClient,
  client: StudentClient | null,
): Promise<'sent' | 'unchanged' | 'failed'> {
  if (!client) return 'unchanged';
  const change = client.consumeAvailabilityChange();
  if (!change) return 'unchanged';
  try {
    // **밖으로 나간다** (10차 I-1). 9차에는 Notification 행만 만들었는데, 그 알림이
    // 닿는 곳이 하필 **앱 안**이다 — 사이드카가 죽어도 앱은 멀쩡히 돌기 때문에
    // 운영자가 어드민을 열 이유가 생기지 않고, 열지 않으면 알림은 아무 일도 하지
    // 않는다. **조용한 실패를 잡으려고 만든 장치를 조용한 채널에 꽂아 둔 셈**이었다.
    //
    // notifyOperators가 인앱 + 웹훅 + 텔레그램을 한 번에 처리한다 — 어느 쪽이
    // 실패해도 나머지는 나가고, 전부 실패해도 던지지 않는다. 여기서 텔레그램을
    // 다시 구현하면 형식·타임아웃·중복 억제가 두 벌이 된다(opsAlertFeed의 판단).
    await notifyOperators(prisma, {
      title: change.to
        ? '[검수] IRIS 복구 — 게시가 정상으로 돌아갑니다'
        : '[긴급][검수] IRIS 연결 유실 — 지금부터 게시가 전부 보류됩니다',
      body: change.to
        ? `학생 모델이 다시 붙었습니다 (${change.detail}).`
        : `${change.detail}\n` +
          // Q0 (2026-08-21 창업자 확정): 검사기가 죽으면 게시를 보류한다.
          // 예전 문구("게시는 계속되지만")는 그 반대 정책의 잔재였다
          '**라이브 검사기 장애로 새 게시가 전부 보류 큐로 갑니다.** 리서처의 판매가 ' +
          '멈추는 중이니 사이드카를 즉시 다시 띄우거나, 오래 걸리면 관리 화면의 ' +
          '**장애 우회 밸브**를 내려 규칙 단독 게시를 재개하십시오 — 밸브는 2시간 뒤 ' +
          '자동으로 되살아나고, 우회된 건은 전부 VALVE_BYPASS 로 기록됩니다.',
      link: '/admin/compliance',
      type: 'COMPLIANCE_REVIEW',
      // 전이에만 울리므로 원래 반복되지 않지만, 웹 프로세스가 둘이면 각자 자기
      // 엣지를 본다 — 같은 사고로 두 통이 나가는 자리를 키로 막는다
      dedupeKey: `student.availability.${change.to ? 'up' : 'down'}`,
    });
    return 'sent';
  } catch (e) {
    // 알림 실패가 게시를 막으면 "권한 없는 판정이 게시를 죽인" 것이 된다
    console.error('학생 가용 상태 알림 실패:', e);
    return 'failed';
  }
}

/** 검수 실행 (기록 없음) — 순수 조합 로직이라 테스트가 쉽다 */
/**
 * **검수 기록에 박히는 표식을 만든다** — 조립 규칙의 정의는 여기 하나뿐이다 (2026-08-23).
 *
 * 기록의 `reviewer` 는 "이 리포트를 누가 봤나"라 **참여한 검사기를 이어 붙인** 값이다:
 *
 *   rule                                 규칙만 (AI 키 없음 · 학생 꺼짐)
 *   rule+student:IRIS.v5@t0.7/L7         규칙 + IRIS
 *   rule+claude:…+student:…              셋 다
 *
 * 운영 상세 화면도 같은 문자열을 보여 줘야 하는데, 거기서 `rule+` 를 손으로 이어 붙이면
 * AI 를 켜는 날 조용히 갈라진다 — 오늘 `nextAt` 에서 겪은 것과 같은 모양이라, 조립을
 * 함수로 꺼내 **양쪽이 같은 것을 쓰게** 한다.
 */
export function composeReviewerStamp(base: string, studentId: string | null): string {
  return studentId ? `${base}+${studentId}` : base;
}

export async function runScreening(
  input: ScreeningInput,
  screener: ComplianceScreener | null,
  ctx: ScreeningContext = {},
): Promise<ComplianceResult> {
  const tier1 = await collectAutoScreenFindings(input, ctx);
  // **즉시 거절 판단은 코드 규칙만으로 한다.** 학습 표현·의미 검색·학생은 전부 WARN이라
  // 이 값을 움직일 수 없고, 그것이 "사람 확인 없이 정상 리포트를 죽이지 않는다"는
  // 이 파이프라인의 절대 조건을 지키는 방식이다.
  const ruleDecision = decide(tier1.code);
  const ruleFindings = tier1.all;


  // 판정에 **무엇이 참여했는지**를 기록에 남긴다. 나중에 "이 소견은 누가 냈나"를
  // findingsJson 없이도 알 수 있어야 하고, 학생을 껐다 켜는 구간의 비교가 여기서 갈린다.
  const withStudent = (base: string) => composeReviewerStamp(base, ctx.student?.reviewerId ?? null);

  // ── 검사기가 죽으면 게시를 보류한다 (Q0 · 2026-08-21 창업자 확정) ──────────
  //
  // 라이브 학생이 **있어야 하는데 없거나**(resolveLiveStudent 의 outage) **부르다
  // 죽었으면**(studentFailed), 소견이 0건이어도 통과시키지 않는다. 예전에는 이 경우
  // 규칙 단독으로 조용히 게시됐다 — 검수가 가장 약한 순간에 아무도 모르는 채로.
  //
  // 순서에 뜻이 있다: **규칙 BLOCK 이 먼저다.** 코드 규칙의 거절은 학생과 무관하게
  // 확정이므로, 장애 중이라고 거절할 것을 보류로 낮추면 안 된다.
  // UNAVAILABLE 을 재활용하는 이유: 뜻이 정확히 같고("검수기 일부가 판단하지 못했다"),
  // 정확도 집계가 이 값을 이미 표본에서 뺀다(classifyReview — 판단이 없었으므로
  // 맞고 틀림을 따질 대상이 없다). reviewer 의 `(장애)` 조각이 어느 검사기였는지 남긴다.
  const studentDown = ctx.studentOutage === true || tier1.studentFailed;
  if (ruleDecision !== 'BLOCK' && studentDown && ctx.studentBypass !== true) {
    return {
      decision: 'UNAVAILABLE',
      action: 'HOLD',
      findings: ruleFindings,
      reviewer: `${withStudent('rule')}+student(장애)`,
      needsOperatorReview: true,
      studentAbsence: 'OUTAGE_HOLD',
      studentDown: true,
    };
  }

  // 밸브가 내려간 동안의 우회는 **영구 꼬리표**를 달고 흐른다 (21차 Y-1(b)).
  // BLOCK 은 제외 — 규칙 거절은 학생 결석과 무관하게 확정이라 꼬리표가 뜻을 잃는다
  const studentAbsence =
    studentDown && ruleDecision !== 'BLOCK' ? ('VALVE_BYPASS' as const) : undefined;

  // 규칙이 차단했거나 AI 검수기가 없으면 규칙 결과가 최종
  if (ruleDecision === 'BLOCK' || !screener) {
    const decision = decide(ruleFindings);
    return {
      decision,
      action: resolveAction(ruleDecision, decision),
      findings: ruleFindings,
      reviewer: withStudent('rule'),
      needsOperatorReview: resolveAction(ruleDecision, decision) === 'HOLD',
      studentAbsence,
      studentDown: studentDown || undefined,
    };
  }

  let output: ScreeningOutput;
  try {
    output = await screener.screen(input, ctx.calibration ?? []);
  } catch (e) {
    // 검수 실패로 게시를 거절하지는 않는다 — 외부 장애로 정상 리포트가 반려되면 안 된다.
    // 대신 판매도 시작하지 않고 운영자 검토로 돌린다.
    console.error('컴플라이언스 AI 검수 실패:', e);
    return {
      decision: 'UNAVAILABLE',
      action: 'HOLD',
      findings: ruleFindings,
      reviewer: withStudent(`rule+${screener.reviewerId}(실패)`),
      needsOperatorReview: true,
      studentAbsence,
      studentDown: studentDown || undefined,
    };
  }

  const findings = mergeFindings(ruleFindings, output.findings);
  const decision = decide(findings);
  const action = resolveAction(ruleDecision, decision);
  return {
    decision,
    action,
    findings,
    reviewer: withStudent(`rule+${screener.reviewerId}`),
    needsOperatorReview: action === 'HOLD',
    usage: output.usage,
    studentAbsence,
    studentDown: studentDown || undefined,
  };
}

/** 검수 실행 + 이력 기록. 차단된 시도도 남긴다 (반복 위반 탐지 근거) */
export async function screenAndRecord(
  prisma: PrismaClient,
  reportId: string,
  input: ScreeningInput,
  screener: ComplianceScreener | null,
  now = new Date(),
  /**
   * false면 **검수만 하고 아무것도 기록하지 않는다** — 게시 전 되묻기 팝업의 프리뷰용.
   * 리뷰 행·hit·알림·그림자·졸업 관찰을 모두 건너뛴다. 큐(getPendingComplianceReviews)는
   * 미해결 리뷰를 리포트당 dedupe 없이 전부 담으므로, 커밋하지 않을 검수가 리뷰를 남기면
   * 리서처가 팝업에서 취소해도 큐에 유령 항목이 생긴다. 그래서 프리뷰는 runScreening 만 돌고
   * 곧장 결과를 돌려준다.
   */
  commit = true,
): Promise<ComplianceResult> {
  // 운영자 판정이 다음 검수로 되돌아오는 두 통로.
  // 조회 실패가 게시를 막으면 안 되므로 실패해도 빈 값으로 진행한다.
  const fallback = <T>(e: unknown, empty: T): T => {
    console.error('검수 보조 데이터 조회 실패:', e);
    return empty;
  };
  const [calibration, phrases, knownNames] = await Promise.all([
    screener
      ? getCalibrationExamples(prisma).catch((e) => fallback(e, [] as CalibrationExample[]))
      : Promise.resolve([] as CalibrationExample[]),
    getActiveLearnedPhrases(prisma).catch((e) => fallback(e, [] as LearnedPhrase[])),
    getKnownInstrumentNames(prisma),
  ]);

  // 학생 모델 — 모드가 결정한다 (8차 E-6). 라이브면 1차 소견에 합류해 보류를 유발하고,
  // 그림자면 커밋 뒤에 기록만 한다. **라이브 진입에는 지문 대조(usable)를 반드시 통과해야
  // 한다** — 그림자에서는 어긋난 기록을 버리면 그만이지만, 라이브에서 틀린 소견은
  // 리서처의 게시를 실제로 멈춘다.
  const mode = studentMode();
  const student = mode === 'off' ? null : createStudentClientFromEnv();
  const live = await resolveLiveStudent(prisma, mode, student);
  // 장애 우회 밸브 — 조회 실패는 "밸브 없음"으로 (보류 쪽이 안전한 기본값)
  const bypass = await getStudentBypass(prisma, now).catch(() => ({
    active: false,
    until: null,
  }));

  const result = await runScreening(input, screener, {
    calibration,
    phrases,
    student: live.client,
    // 라이브인데 장애면 runScreening 이 보류를 낸다 (Q0)
    studentOutage: live.outage,
    studentBypass: bypass.active,
    knownNames,
  });
  // 프리뷰(commit=false): 검수 결과만 돌려주고 기록·알림·그림자를 전부 건너뛴다.
  if (!commit) return result;
  const usage = result.usage as ScreeningUsage | undefined;

  // 장애 전이 기록 — 띠지의 "장애 N시간째"(2회차 B-1). 라이브 경로의 장애만 장애다:
  // off·shadow 는 의도된 끔이라 여기서 false 로 들어와 남은 장애 기록을 걷는다.
  // 기록 실패가 게시를 막으면 안 된다 (계기판이 검수를 죽일 자격은 없다)
  await recordStudentOutage(
    prisma,
    live.outage || result.studentDown === true,
    now,
  ).catch((e) => console.error('학생 장애 전이 기록 실패:', e));

  // 검수 기록 id를 미리 만든다 — 그림자 판정이 이 행을 가리켜야 하는데, 그림자 기록은
  // **이 트랜잭션에 끼면 안 되기 때문**이다(권한 없는 판정이 게시를 죽이면 안 된다).
  // id를 먼저 정하면 트랜잭션을 키우지 않고도 커밋 후 연결할 수 있다.
  // cuid2 패키지를 새로 들이지 않고 node:crypto를 쓴다 — 이 저장소가 이미 쓰는 관례이고,
  // id 칼럼은 문자열이라 형식이 섞여도 무방하다 (@default(cuid())는 값을 주면 안 쓰인다)
  const reviewId = randomUUID();

  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.complianceReview.create({
      data: {
        id: reviewId,
        reportId,
        decision: result.decision,
        reviewer: result.reviewer,
        findingsJson: JSON.stringify(result.findings),
        needsOperatorReview: result.needsOperatorReview,
        // 학생 결석 꼬리표 (21차 Y-1(b)) — "소견 0(정상)"과 "결석(장애·우회)"을 가른다
        studentAbsence: result.studentAbsence ?? null,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        deliberationRatio: usage ? deliberationRatio(usage) : null,
        createdAt: now,
      },
    }),
  ];

  // 학습 표현이 걸린 횟수를 센다 — 표현별 정확도(걸린 것 중 실제 반려 비율)의 분모.
  // **표현마다 대표 소견 하나**를 골라 둔다 — 같은 표현이 두 번 걸려도 hit·matchCount 는
  // 표현당 1이고(기존 계약), 스냅샷은 그 첫 소견에서 뜬다
  const phraseFindings = new Map<string, Finding>();
  for (const f of result.findings) {
    if (f.phraseId && !phraseFindings.has(f.phraseId)) phraseFindings.set(f.phraseId, f);
  }
  const matchedPhraseIds = [...phraseFindings.keys()];
  if (matchedPhraseIds.length > 0) {
    writes.push(
      prisma.learnedPhrase.updateMany({
        where: { id: { in: matchedPhraseIds } },
        data: { matchCount: { increment: 1 }, lastMatchedAt: now },
      }),
    );
    // **누가 걸렸는지도 남긴다** (관리자 앱 인계서 2026-08-22 §1 → 회신 8호 (나)).
    // matchCount 숫자만으로는 "서로 다른 리서처 ≥ 5명"(코드 규칙 후보 조건 넷째)을 셀 수
    // 없다 — 한 사람이 같은 문구를 30번 써서 만든 30회와 30명이 만든 30회가 같은 숫자다.
    //
    // **매칭 스냅샷도 이 순간 함께 박는다 (회신 20호 요청 1).** 반려되면 본문이 바뀌어
    // 소급 복원이 안 되므로, 소견의 quote·span 으로 문맥·출현형·부정을 지금 계산해 둔다.
    // (새 표라 클라이언트 타입 재생성 전에도 돌아야 해서 raw 로 쓴다)
    const owner = await prisma.report.findUnique({
      where: { id: reportId },
      select: { researcherId: true },
    });
    if (owner) {
      const text = screeningText(input);
      for (const [phraseId, finding] of phraseFindings) {
        const snap = phraseHitSnapshot(finding, text);
        writes.push(
          prisma.$executeRaw`INSERT INTO "LearnedPhraseHit"
            ("id", "phraseId", "reportId", "researcherId", "createdAt", "matchedSentence", "matchedSurface", "negation")
            VALUES (${randomUUID()}, ${phraseId}, ${reportId}, ${owner.researcherId}, ${now.getTime()},
              ${snap.sentence}, ${snap.surface}, ${snap.negation})`,
        );
      }
    }
  }

  // 2단 검수로 결론이 나지 않은 건은 운영자에게 즉시 알린다.
  // 큐 페이지를 열어봐야만 알 수 있으면 위반 콘텐츠가 팔리는 시간이 길어진다.
  if (result.needsOperatorReview) {
    const operators = await prisma.user.findMany({
      where: { role: 'OPERATOR' },
      select: { id: true },
    });
    const label =
      result.decision === 'UNAVAILABLE'
        ? 'AI 검수 실패'
        : result.decision === 'BLOCK'
          ? 'AI 위반 판정'
          : '검수 경고';
    for (const op of operators) {
      writes.push(
        prisma.notification.create({
          data: {
            userId: op.id,
            type: 'COMPLIANCE_REVIEW',
            title: `[${label}] 게시 보류 — 검토 필요: ${input.title}`,
            body:
              result.decision === 'UNAVAILABLE'
                ? 'AI 검수가 실패해 결정적 규칙만 적용됐습니다. 게시를 보류했으니 본문을 확인해 게시 승인 또는 반려를 결정해주세요.'
                : `${findingMessages(result.findings).join(' / ')} — 게시를 보류했습니다. 본문을 확인해 게시 승인 또는 반려를 결정해주세요.`,
            link: '/admin/compliance',
            createdAt: now,
          },
        }),
      );
    }
  }

  await prisma.$transaction(writes);

  // ── 그림자 모드 ──────────────────────────────────────────────────
  // 커밋 **뒤에** 돈다. 트랜잭션 안에 넣으면 사이드카 지연이 게시 트랜잭션을 늘리고,
  // 그 트랜잭션이 길어지면 SQLite 쓰기 락이 결제까지 밀어낸다(measure:contention 실측).
  // 커밋과 그림자 기록 사이에 프로세스가 죽으면 그 건의 그림자만 비는데, 그건 결측이지
  // 사고가 아니다 — 학생은 아직 아무것도 처리하지 않는다.
  // **라이브일 때는 돌지 않는다.** 소견이 이미 본 기록에 source='student'로 들어 있어
  // 운영자 판정(정탐/오탐 라벨)이 그 행에 그대로 붙고, screeningAccuracy 가 출처별로
  // 갈라 센다 — 그림자 표가 답하던 질문에 본 기록이 더 잘 답한다. 여기서 또 부르면
  // 리포트마다 사이드카 호출이 두 배가 되고, 두 번의 답이 다르면 어느 쪽이 판정에
  // 쓰인 것인지 알 수 없게 된다.
  if (live.client === undefined) {
    await recordShadowJudgment(prisma, reviewId, input, student, now);
  }

  // ── 졸업 관찰 (21차 Y-3) — 졸업 직후 7일간 그 표현을 감시 전용으로 계속 돈다 ──
  // 커밋 뒤에 돈다 — 관찰 기록이 게시 트랜잭션을 늘리면 안 되고, 실패는 결측이다.
  await recordGraduationWatch(prisma, reviewId, input, result.findings, knownNames, now).catch(
    (e) => console.error('졸업 관찰 기록 실패:', e),
  );

  // 가용 상태가 **바뀐 순간에만** 운영자에게 알린다 (9차 G-2). 커밋 뒤에 돈다 —
  // 그림자 기록과 같은 이유로, 알림 경로의 지연이 게시 트랜잭션을 늘리면 안 된다.
  await notifyStudentAvailability(prisma, student);

  // 학생을 계속 켜 둘 것인가를 **주기적으로 다시 잰다** (10차 I-6). 적자면 스스로
  // shadow로 내려간다 — 9차의 계기판은 운영자가 어드민을 열어야 보이는데, 학생이
  // 오탐을 쏟아내도 앱은 멀쩡히 돌아 그 화면을 열 이유가 생기지 않는다.
  // 라이브가 아니면 재지 않는다: 학생이 소견을 안 내는 동안의 숫자는 "좋아졌다"가
  // 아니라 "모른다"이고, 그 둘을 섞으면 걸쇠가 스스로 풀린다.
  if (live.client) await runAutoShadowCheck(prisma, now);

  return result;
}

/**
 * 검수 비용·숙고량 통계 — 모델 선택과 에스컬레이션 임계값을 데이터로 정하기 위한 집계.
 * 운영 초기 수십 건만 쌓여도 실제 분포가 보인다.
 */
export async function getScreeningUsageStats(prisma: PrismaClient) {
  const rows = await prisma.complianceReview.findMany({
    where: { inputTokens: { not: null } },
    select: { inputTokens: true, outputTokens: true, deliberationRatio: true, decision: true },
    orderBy: { createdAt: 'desc' },
    take: 1_000,
  });
  if (rows.length === 0) return null;

  const sum = (pick: (r: (typeof rows)[number]) => number) =>
    rows.reduce((acc, r) => acc + pick(r), 0);
  const ratios = rows
    .map((r) => r.deliberationRatio ?? 0)
    .sort((a, b) => a - b);
  const percentile = (p: number) => ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * p))];

  return {
    samples: rows.length,
    avgInputTokens: Math.round(sum((r) => r.inputTokens ?? 0) / rows.length),
    avgOutputTokens: Math.round(sum((r) => r.outputTokens ?? 0) / rows.length),
    // 임계값 후보 — 상위 10~20%를 자르는 선이 에스컬레이션 기준이 된다
    ratioP50: percentile(0.5),
    ratioP80: percentile(0.8),
    ratioP90: percentile(0.9),
  };
}

/**
 * 운영자 검토 대기 큐 — 보류가 오래된 순.
 * 정렬 기준이 보류 경과 시간인 이유: 리서처는 결정이 날 때까지 판매를 못 한다.
 * 대기가 길어질수록 예측의 가치가 떨어지므로(특히 단기 카드) 오래된 건이 먼저다.
 */
export function getPendingComplianceReviews(prisma: PrismaClient) {
  return prisma.complianceReview.findMany({
    where: { needsOperatorReview: true, operatorReviewedAt: null },
    include: {
      report: {
        select: {
          id: true,
          title: true,
          // 본문·요약을 싣는다 — 검수 상세가 **문제 삼은 워딩을 본문 안에서 빨갛게**
          // 보여주려면 소견 인용문뿐 아니라 원문 전체가 있어야 한다 (2026-08-26 창업자 지시).
          // 운영자 화면이라 마스킹 대상이 아니다(마스킹은 구매자용). 카드의 종목·목표가는
          // 본문에 없어 여기 없다 — 그건 전체 화면 링크가 채운다
          summary: true,
          content: true,
          status: true,
          // 교사 질의를 강제할지 가른다 (18차 V-7) — 반려를 반복하며 문구만 고쳐 오면
          // 규칙을 이진 탐색하는 중일 수 있어 사람이 한 번 더 본다
          rejectionCount: true,
          researcher: {
            // tier는 정렬 기준(리서처 등급)에 쓰인다
            select: { id: true, tier: true, user: { select: { id: true, penName: true, email: true } } },
          },
          // 강제 철회 시 환불될 규모 — 운영자가 집행 전에 영향 범위를 보고 판단해야 한다
          purchases: { where: { escrowStatus: 'HELD' }, select: { amountKrw: true } },
          // 검증 시한 — 대기 중 시한이 다가오면 승인해도 게시 조건을 못 맞출 수 있다.
          // 카드 값(종목·방향·목표)은 근거 문장 짚기에서 **본문에 없는 카드 위반**을 짚게 한다 (2026-08-28)
          predictionCard: {
            select: {
              deadline: true,
              assetClass: true,
              ticker: true,
              assetName: true,
              direction: true,
              targetType: true,
              targetValue: true,
              basePrice: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * 판매 중 리포트 목록 (최근순) — 강제 철회의 진입점.
 * 검토 큐는 "보류 중"만 담기 때문에, 승인 후 문제가 드러난 리포트를 내리려면
 * 판매 중인 것들을 볼 수 있어야 한다.
 */
export function getPublishedReportsForOversight(prisma: PrismaClient, limit = 20) {
  return prisma.report.findMany({
    where: { status: 'PUBLISHED' },
    select: {
      id: true,
      title: true,
      status: true,
      content: true, // 강제 철회 때 근거 문장 지목(EvidencePicker)에 쓴다 (회신 20호 요청 3)
      publishedAt: true,
      researcher: {
        select: { id: true, tier: true, user: { select: { id: true, penName: true, email: true } } },
      },
      purchases: { where: { escrowStatus: 'HELD' }, select: { amountKrw: true } },
      // 카드 값 — 강제 철회 근거 문장 짚기에서 본문에 없는 카드 위반을 짚게 한다 (2026-08-28)
      predictionCard: {
        select: {
          deadline: true,
          assetClass: true,
          ticker: true,
          assetName: true,
          direction: true,
          targetType: true,
          targetValue: true,
          basePrice: true,
        },
      },
      _count: { select: { purchases: true } }, // 판매량 정렬 기준 (환불 건 포함 누적)
    },
    orderBy: { publishedAt: 'desc' },
    take: limit,
  });
}

/**
 * 리서처별 누적 판매 건수 — 보류 건 정렬(판매량)에 쓴다.
 * 보류 중인 리포트는 아직 판매 전이라 자기 판매량이 0이므로,
 * "이 리서처가 얼마나 팔아온 사람인가"를 대신 본다.
 */
export async function researcherSalesCounts(
  prisma: PrismaClient,
  researcherIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (researcherIds.length === 0) return counts;

  const rows = await prisma.report.findMany({
    where: { researcherId: { in: researcherIds } },
    select: { researcherId: true, _count: { select: { purchases: true } } },
  });
  for (const r of rows) {
    counts.set(r.researcherId, (counts.get(r.researcherId) ?? 0) + r._count.purchases);
  }
  return counts;
}

// ── 운영자 판정 기록 (정답 라벨) ──────────────────────────────────────
//
// 운영자의 결정은 큐에서 건을 내리는 행위이자, 검수가 맞았는지에 대한 유일한 정답이다.
// 그래서 종결 처리와 라벨 기록을 같은 쓰기로 묶는다 — 따로 두면 라벨이 비어 있는
// 종결 건이 쌓여 측정이 불가능해진다.

export interface VerdictLabel {
  /** 반려·철회 사유 */
  reason?: string;
  /** 운영자가 확인한 실제 위반 유형 (비우면 검수 소견을 그대로 인정).
   *  내장 RiskCategory key 또는 운영자가 정의한 커스텀 유형 라벨(문자열) — 둘 다 온다 */
  categories?: string[];
  /** 승인 시: 지적 자체는 타당했는가 (경미해서 승인한 경우 true) */
  /** 11차 K-1 — 세 갈래. `null`(무응답)과 `false`(명시적 오탐 신고)를 갈라 둔다 */
  findingsValid?: boolean | null;
  /** 반려·철회 때 운영자가 본문에서 짚은 근거 문장 (회신 20호 요청 3) — IRIS 라벨 지역화용 */
  evidence?: string[];
}

/** 판정 기록의 입력 검증 실패 — 운영자 화면이 그대로 띄울 문장을 담는다 */
export class ComplianceVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceVerdictError';
  }
}

/**
 * 규칙·사전(·옛 AI)이 낸 소견이 하나라도 있는가. 없으면 "IRIS 만 잡았거나 아무도 못 잡은 건"이다.
 * source 없는 옛 기록은 규칙 소견으로 본다(보수 — 모르면 IRIS 몫으로 세지 않는다).
 * 깨진 JSON·빈 소견은 false — 아무도 못 잡은 것과 같다.
 */
function hasNonStudentFinding(findingsJson: string): boolean {
  try {
    return (JSON.parse(findingsJson) as Finding[]).some((f) => f.source !== 'student');
  } catch {
    return false;
  }
}

/**
 * 리포트의 검수 건에 운영자 판정을 기록하는 쓰기 (호출자의 트랜잭션에 합류).
 *
 * 대기 중인 건이 있으면 그것들에, 없으면 **가장 최근 검수 건**에 기록한다.
 * 후자가 중요하다: 검수를 통과(PASS)해 게시된 리포트가 나중에 강제 철회되면
 * 대기 건이 없는데, 바로 그 경우가 미탐(놓친 위반)의 유일한 관측 경로다.
 */
export async function operatorVerdictWrites(
  prisma: PrismaClient,
  reportId: string,
  verdict: OperatorVerdict,
  operatorUserId: string,
  now: Date,
  label: VerdictLabel = {},
): Promise<Prisma.PrismaPromise<unknown>[]> {
  const evidence = (label.evidence ?? []).map((q) => q.trim()).filter((q) => q.length > 0);
  const data = {
    operatorReviewedAt: now,
    operatorReviewedBy: operatorUserId,
    operatorVerdict: verdict,
    operatorReason: label.reason?.trim() || null,
    operatorCategories: label.categories?.length ? JSON.stringify(label.categories) : null,
    aiFindingsValid: label.findingsValid ?? null,
    // 근거 문장 (회신 20호 요청 3) — 있으면 JSON 배열로, 없으면 null(종전대로 문서 라벨)
    operatorEvidence: evidence.length ? JSON.stringify(evidence) : null,
  };

  const [pendingCount, latest] = await Promise.all([
    prisma.complianceReview.count({
      where: { reportId, needsOperatorReview: true, operatorReviewedAt: null },
    }),
    prisma.complianceReview.findFirst({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, findingsJson: true },
    }),
  ]);

  // **IRIS 만 잡은 건을 큐에서 반려할 때는 근거 문장이 필수다** (2026-09-01 창업자 확정).
  // IRIS 소견은 문장을 짚지 못하므로(문서 전체 판정), 이런 건에서 근거 문장을 안 짚으면
  // "IRIS 유형별 문장 모음"(졸업 강등 본선 재료)이 **영원히 안 쌓인다**. 규칙·사전이 소견을
  // 낸 건은 소견 자체가 문장을 짚고 있어 종전대로 선택이다.
  // 범위는 **반려·강제 철회·신고 확인(미탐) 셋 다** (2026-09-01 창업자 확정). 세 화면
  // (ResolveButton·AbuseGroupResolve) 모두 근거 문장 선택기를 갖고 있고 철회·확인은 이미
  // 화면에서 필수다 — 서버가 같은 것을 요구해야 화면과 관문이 갈라지지 않는다
  if (
    (verdict === 'REJECTED' || verdict === 'TAKEDOWN' || verdict === 'MISSED') &&
    evidence.length === 0 &&
    latest &&
    !hasNonStudentFinding(latest.findingsJson)
  ) {
    throw new ComplianceVerdictError(
      '이 건은 규칙·사전이 잡지 못하고 IRIS 만 잡았거나 아무도 못 잡은 건입니다 — 본문에서 근거 문장을 하나 이상 짚어 주세요. ' +
        '그 문장이 코드화(사전 등록·규칙) 논의의 유일한 재료가 됩니다.',
    );
  }

  // 학습 표현의 정확도 라벨 — 이 표현이 걸린 건이 실제 반려로 확정됐는가.
  // 규칙·AI와 같은 잣대를 사전에도 적용해야 오탐 표현이 영원히 남지 않는다.
  const confirmedPhraseIds =
    verdict === 'REJECTED' || verdict === 'TAKEDOWN' ? confirmedPhrases(latest, label) : [];
  const phraseWrites = confirmedPhraseIds.length
    ? [
        prisma.learnedPhrase.updateMany({
          where: { id: { in: confirmedPhraseIds } },
          data: { confirmedCount: { increment: 1 } },
        }),
      ]
    : [];

  // **hit 스냅샷의 판정 칸을 갱신한다 (회신 20호 요청 1).** 이 리포트에서 걸린 학습 표현
  // hit 전부에 최종 판정을 박아 문장 단위 정탐/오탐과 대비쌍(요청 4)의 재료로 남긴다.
  // 판정 enum 을 그대로 저장한다(REJECTED/TAKEDOWN/APPROVED/KEPT/MISSED) — 대상 행이
  // 없으면 updateMany 는 무해하게 0행을 고친다
  const hitVerdictWrite = prisma.learnedPhraseHit.updateMany({
    where: { reportId },
    data: { verdict },
  });

  if (pendingCount > 0) {
    return [
      prisma.complianceReview.updateMany({
        where: { reportId, needsOperatorReview: true, operatorReviewedAt: null },
        data,
      }),
      ...phraseWrites,
      hitVerdictWrite,
    ];
  }
  if (!latest) return [];
  return [
    prisma.complianceReview.update({ where: { id: latest.id }, data }),
    ...phraseWrites,
    hitVerdictWrite,
  ];
}

/**
 * 반려·철회로 확정된 학습 표현 id.
 * 운영자가 실제 위반 유형을 따로 지목했다면 그 유형의 표현만 인정한다 —
 * "반려는 맞았지만 이 표현 때문은 아니었다"를 구분해야 사전이 정확해진다.
 */
function confirmedPhrases(
  review: { findingsJson: string } | null,
  label: VerdictLabel,
): string[] {
  if (!review) return [];
  let findings: Finding[] = [];
  try {
    const parsed = JSON.parse(review.findingsJson);
    if (Array.isArray(parsed)) findings = parsed as Finding[];
  } catch {
    return [];
  }
  const actual = label.categories?.length ? new Set(label.categories) : null;
  return [
    ...new Set(
      findings.flatMap((f) =>
        f.phraseId && (actual === null || actual.has(f.category)) ? [f.phraseId] : [],
      ),
    ),
  ];
}

/** 운영자 확인 처리 — 판매 중 리포트를 검토 후 유지 (큐에서 제거 + 라벨 기록) */
export async function markComplianceReviewed(
  prisma: PrismaClient,
  reviewId: string,
  operatorUserId: string,
  now = new Date(),
) {
  await prisma.complianceReview.update({
    where: { id: reviewId, operatorReviewedAt: null },
    data: {
      operatorReviewedAt: now,
      operatorReviewedBy: operatorUserId,
      operatorVerdict: 'KEPT',
    },
  });
}

// ── 정확도 집계·되먹임 ────────────────────────────────────────────────

type ReviewRow = {
  decision: string;
  findingsJson: string;
  operatorVerdict: string | null;
  operatorReason: string | null;
  operatorCategories: string | null;
  aiFindingsValid: boolean | null;
  /* 판단 시간이 **없는 이유**를 가르는 재료 (2026-08-24). 정확도 계산에는 안 들어간다 */
  operatorReviewedAt?: Date | null;
  decisionElapsedMs?: number | null;
};

/** DB 행 → 도메인 표본. 저장된 JSON은 방어적으로 파싱한다 (구버전 행 존재) */
function toLabeledReview(row: ReviewRow): LabeledReview {
  const parse = <T>(json: string | null, fallback: T): T => {
    if (!json) return fallback;
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    decision: row.decision as ComplianceDecision,
    findings: parse<Finding[]>(row.findingsJson, []),
    verdict: (row.operatorVerdict as OperatorVerdict | null) ?? null,
    findingsValid: row.aiFindingsValid,
    actualCategories: parse<RiskCategory[]>(row.operatorCategories, []),
    operatorReason: row.operatorReason,
    reviewedAt: row.operatorReviewedAt ? row.operatorReviewedAt.getTime() : null,
    elapsedMs: row.decisionElapsedMs ?? null,
  };
}

const LABEL_SELECT = {
  decision: true,
  findingsJson: true,
  operatorVerdict: true,
  operatorReason: true,
  operatorCategories: true,
  aiFindingsValid: true,
  operatorReviewedAt: true,
  decisionElapsedMs: true,
} as const;

/**
 * 검수 정확도 — 운영자 판정이 붙은 건만 집계한다.
 * 이 수치가 축 2(모델 캐스케이드)·축 3(리스크 기반 차등)의 판단 근거가 된다.
 */
export async function getScreeningAccuracy(prisma: PrismaClient, take = 500) {
  const rows = await prisma.complianceReview.findMany({
    where: { operatorVerdict: { not: null } },
    select: LABEL_SELECT,
    orderBy: { createdAt: 'desc' },
    take,
  });
  // 측정 시작일을 **주입한다** — 도메인은 순수 함수라 배포일을 모른다 (§SummarizeOptions)
  return summarizeAccuracy(rows.map(toLabeledReview), {
    measureStartMs: ELAPSED_MEASURE_START,
  });
}

/**
 * **학생 모델을 계속 켜 둘 것인가** (9차 검토 G-4).
 *
 * 채택은 홀드아웃 손코퍼스에서 정했지만, 진짜 정답은 운영자 판정이다. 채택선과 **같은
 * 공식**(순이익)으로 최근 창을 다시 재서, 적자로 돌아서면 끄라고 말한다 — 켤 때와 끌 때의
 * 잣대가 다르면 두 판단이 서로를 반박한다.
 */
export async function getStudentRollbackStatus(prisma: PrismaClient) {
  const rows = await prisma.complianceReview.findMany({
    where: { operatorVerdict: { not: null } },
    select: LABEL_SELECT,
    orderBy: { createdAt: 'desc' },
    // 창보다 넉넉히 가져온다 — 학생이 말하지 않은 건은 창에서 빠지므로,
    // 정확히 창 크기만 조회하면 실제 표본이 늘 창보다 작다
    take: ROLLBACK_WINDOW * 4,
  });
  return studentRollbackStatus(rows.map(toLabeledReview));
}

/**
 * 자동 격하 판정을 한 번 돌린다 (10차 I-6).
 *
 * 조회를 여기서 하고 판정은 순수 함수에 맡긴다 — 그래야 합성 트래픽으로 격발 지점을
 * 검증할 수 있다. **어떤 실패도 던지지 않는다**: 이 장치가 게시를 죽이면, 학생에게
 * 거절 권한을 주지 않기로 한 이유가 뒷문으로 되돌아온다.
 */
export async function runAutoShadowCheck(prisma: PrismaClient, now = new Date()): Promise<void> {
  try {
    const rows = await prisma.complianceReview.findMany({
      where: { operatorVerdict: { not: null } },
      select: LABEL_SELECT,
      orderBy: { createdAt: 'desc' },
      take: ROLLBACK_WINDOW * 4,
    });
    const { engaged, status } = await evaluateAutoShadow(prisma, rows.map(toLabeledReview), now);
    if (!engaged || !status) return;
    // **밖으로 쏜다.** 자동 격하야말로 조용히 일어나면 안 되는 사건이다 — 검수가
    // 약해진 채로 며칠이 지나도 앱은 아무 증상을 보이지 않는다 (10차 I-1과 같은 이유).
    await notifyOperators(prisma, {
      title: '[검수] IRIS 자동 격하 — 지금 규칙 단독으로 검수 중입니다',
      body:
        `${status.summary}\n` +
        '운영자 판정 기준 순이익이 적자로 돌아서 학생 소견을 자동으로 껐습니다.\n' +
        '**자동으로 다시 켜지지 않습니다** — 끈 동안에는 성적을 잴 재료가 없어서, ' +
        '재학습하고 채택 판정(npm run eval:student)을 다시 통과시킨 뒤 손으로 푸십시오.',
      link: '/admin/compliance',
      type: 'COMPLIANCE_REVIEW',
      dedupeKey: 'student.auto_shadow',
    });
  } catch (e) {
    console.error('학생 자동 격하 판정 실패:', e);
  }
}

/**
 * 유형별 실제 결과 — 작성 화면 경고 문구의 강도를 사실로 조절하기 위한 자료.
 *
 * 오탐률이 높은 유형까지 "게시가 보류됩니다"라고 똑같이 겁을 주면, 리서처는 곧
 * 경고 전체를 무시하게 된다. 그렇다고 표시를 죽이면 서버는 여전히 보류시키므로
 * 화면이 거짓말을 하게 된다. 그래서 **사실을 덧붙인다**:
 * "이 유형으로 보류된 최근 N건 중 M건은 검토 후 승인됐습니다."
 */
export async function getCategoryOutcomeRates(prisma: PrismaClient, take = 500) {
  const summary = await getScreeningAccuracy(prisma, take);
  const rates: Partial<Record<RiskCategory, { flagged: number; approved: number }>> = {};
  for (const c of summary.byCategory) {
    if (c.flagged > 0) rates[c.key] = { flagged: c.flagged, approved: c.falsePositive };
  }
  return rates;
}

/**
 * AI에게 되먹일 오탐 사례.
 * 운영자가 "이건 지적할 게 아니었다"고 판정한 실제 문장을 프롬프트에 넣어
 * 같은 오탐이 반복되지 않게 한다 — 모델을 바꾸지 않고 정확도를 올리는 가장 싼 수단.
 */
export async function getCalibrationExamples(
  prisma: PrismaClient,
  limit = 8,
): Promise<CalibrationExample[]> {
  // **놓친 것도 함께 되먹인다** (2026-08-21). 예전에는 이 함수가 오탐만 뽑아서,
  // AI는 "너무 깐깐했다"만 배우고 "놓쳤다"는 한 건도 못 봤다 — 되먹임이 한쪽으로만
  // 열려 있으면 쓸수록 덜 잡는 쪽으로 기운다.
  //
  // 미탐은 소견이 없어 인용할 문구가 없으므로 **운영자가 등록한 학습 표현**을 쓴다.
  // 그 표현은 `sourceReportId`로 리포트에 매달려 있어 검수 기록과 이어 붙일 수 있다.
  const missRows = await prisma.complianceReview.findMany({
    where: { operatorVerdict: { in: ['TAKEDOWN', 'MISSED'] } },
    select: { ...LABEL_SELECT, reportId: true },
    orderBy: { createdAt: 'desc' },
    take: 40,
  });
  const phraseByReport = new Map<string, string>();
  if (missRows.length > 0) {
    const phrases = await prisma.learnedPhrase.findMany({
      where: { sourceReportId: { in: missRows.map((r) => r.reportId) } },
      select: { sourceReportId: true, phrase: true },
      orderBy: { createdAt: 'desc' },
    });
    for (const p of phrases) {
      if (p.sourceReportId && !phraseByReport.has(p.sourceReportId)) {
        phraseByReport.set(p.sourceReportId, p.phrase);
      }
    }
  }

  const rows = await prisma.complianceReview.findMany({
    // 오탐 후보: 승인·유지로 끝났는데 지적이 타당했다는 표시가 **없는** 건.
    //
    // ⚠ `NOT: { aiFindingsValid: true }` 로 쓰면 안 된다 — SQL 3값 논리에서
    // `NOT (col = true)` 는 col 이 NULL 일 때 **참이 아니라 NULL**이라 그 행이 통째로
    // 빠진다. 11차 K-1 이 기본값을 `false`에서 `null`로 바꾸면서 실제로 그렇게 됐고,
    // **되먹임 자료가 예외도 경고도 없이 0건이 됐다.** db 시험이 잡았다.
    // 두 값을 이름으로 적어 두면 세 번째 값이 생기는 날에도 눈에 띈다.
    where: {
      operatorVerdict: { in: ['APPROVED', 'KEPT'] },
      OR: [{ aiFindingsValid: false }, { aiFindingsValid: null }],
    },
    select: LABEL_SELECT,
    orderBy: { createdAt: 'desc' },
    take: limit * 6, // 규칙 오탐·중복이 걸러지므로 넉넉히 조회한다
  });
  // 미탐 행에는 등록된 표현을 실어 보낸다 — 표현이 없는 건은 도메인이 알아서 버린다
  const missLabeled = missRows.map((r) => ({
    ...toLabeledReview(r),
    missedPhrase: phraseByReport.get(r.reportId) ?? null,
  }));
  return calibrationExamples([...rows.map(toLabeledReview), ...missLabeled], limit);
}

// ── 강제 철회 (운영자 집행 액션) ────────────────────────────────────────
//
// 검토 큐의 WARN·UNAVAILABLE 건을 확인한 결과 실제로 위반이라고 판단했을 때,
// 이미 게시된 리포트를 운영자가 내린다. 확인 도장만 찍는 큐는 집행 수단이 없어
// 규제 리스크를 실제로 줄이지 못한다.
//
// 원칙:
// - 구매자 보호 우선: 시한을 기다리지 않고 즉시 판정 불가(WITHDRAWN) 처리 →
//   에스크로 전액 환불, 플랫폼 수수료 0, 리서처 정산 0 (§2.5·§3.3)
// - 리서처 점수는 0점 (표본 제외) — 위반 콘텐츠가 트랙레코드에 남지 않게
// - 판정·정산·알림은 자동 경로와 동일 함수(buildJudgmentWrites) 공유
// - 사유 필수 + 운영자 식별자를 감사 스냅샷에 기록 (분쟁 재현·이의 제기 대응)
// - 기록은 지우지 않는다: 카드·리포트·검수 이력 모두 보존하고 상태만 CLOSED로 전이

/**
 * 철회를 건너뛴 **사유의 갈래** (2026-08-21).
 *
 * 이 구분이 필요한 이유는 하나다: **`ALREADY_CLOSED`만 미탐이다.**
 *   · `ALREADY_CLOSED` — 이미 판정·철회·종료된 건. 내릴 것이 없을 뿐이고,
 *     운영자가 위반이라고 판단한 것은 그대로 참이라 **검수가 놓친 것**이 맞다
 *   · `NOT_APPLICABLE` — 초안이라 철회 대상이 아님. 팔린 적이 없으니 놓칠 것도 없었다
 *   · `DATA_ERROR`    — 리포트·카드가 없다. 우리 쪽 사고지 검수의 실수가 아니다
 * 뒤의 둘에 미탐을 붙이면 검수 성적이 우리 사고로 나빠진다.
 */
export type TakedownSkipReason = 'ALREADY_CLOSED' | 'NOT_APPLICABLE' | 'DATA_ERROR';

export class ComplianceTakedownError extends Error {
  constructor(
    message: string,
    /** 기본값이 `DATA_ERROR`인 이유: **모르면 미탐으로 세지 않는다.** 성적을 좋게 만드는
     *  방향의 기본값이라 새 예외를 추가하는 사람이 라벨을 잘못 얻을 일이 없다 */
    readonly reason: TakedownSkipReason = 'DATA_ERROR',
  ) {
    super(message);
    this.name = 'ComplianceTakedownError';
  }
}

export interface TakedownInput {
  reportId: string;
  operatorUserId: string;
  /** 강제 철회 사유 — 필수. 감사 스냅샷·검수 라벨에 그대로 실린다 */
  reason: string;
  /** 실제 위반 유형 (선택) — 통과된 건을 철회했다면 검수가 못 잡은 유형이 된다.
   *  내장 key 또는 커스텀 유형 라벨(문자열) */
  categories?: string[];
  /** 운영자가 본문에서 짚은 근거 문장 (회신 20호 요청 3, 선택) — IRIS 라벨 지역화용 */
  evidence?: string[];
  /**
   * 리서처에게 자동 철회 통지를 보낼지 (기본 true).
   *
   * **신고 경로에서만 끈다** (2026-08-20 사용자 확정) — 거기서는 운영자가 확인 창에서
   * 리서처에게 직접 쓴 쪽지가 나가므로, 정형문까지 보내면 한 사건에 두 통이 된다.
   * 판매 중 리포트에서 곧장 내리는 경로(/admin/compliance)에는 쓸 사람이 없으므로
   * 기본값이 살아 있어야 한다 — 그 길에서 이 통지가 유일한 알림이다.
   *
   * 통지를 끄더라도 **사유는 감사 스냅샷과 검수 라벨에 그대로 남는다.**
   */
  notifyResearcher?: boolean;
}

export interface TakedownSummary {
  reportId: string;
  /** 환불 대상이 된 에스크로 보관 구매 건수 */
  refundedPurchases: number;
  refundedAmountKrw: number;
}

export async function forceWithdrawReport(
  prisma: PrismaClient,
  input: TakedownInput,
  now = new Date(),
): Promise<TakedownSummary> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new ComplianceTakedownError('강제 철회 사유는 필수입니다');
  }

  const report = await prisma.report.findUnique({
    where: { id: input.reportId },
    include: {
      purchases: { where: { escrowStatus: 'HELD' } },
      researcher: { select: { userId: true } },
      predictionCard: { include: { judgment: { select: { id: true } } } },
    },
  });
  if (!report) throw new ComplianceTakedownError('리포트를 찾을 수 없습니다', 'DATA_ERROR');
  if (report.status !== 'PUBLISHED') {
    // **팔린 적이 있는가**로 가른다 (2026-08-21). `CLOSED`만 "한때 팔렸다"이고,
    // 초안·보류는 판매가 시작된 적이 없어 검수가 놓칠 기회 자체가 없었다 —
    // 여기에 미탐을 붙이면 **게시된 적도 없는 글로 검수 성적이 깎인다.**
    // (시험이 실제로 잡았다: 보류 중인 리포트가 `이미 철회·종료`로 뭉뚱그려져 있었다)
    throw new ComplianceTakedownError(
      report.status === 'CLOSED'
        ? '이미 철회·종료된 리포트입니다'
        : '아직 판매를 시작하지 않은 리포트입니다 — 강제 철회 대상이 아닙니다',
      report.status === 'CLOSED' ? 'ALREADY_CLOSED' : 'NOT_APPLICABLE',
    );
  }
  const card = report.predictionCard;
  if (!card) throw new ComplianceTakedownError('예측 카드가 없습니다', 'DATA_ERROR');
  if (card.judgment) {
    throw new ComplianceTakedownError(
      '이미 판정이 완료된 카드입니다 — 정산이 끝난 건은 철회할 수 없습니다',
      'ALREADY_CLOSED',
    );
  }
  if (card.withdrawnAt) {
    throw new ComplianceTakedownError('이미 철회된 카드입니다', 'ALREADY_CLOSED');
  }

  const audit = {
    takedown: true,
    operatorUserId: input.operatorUserId,
    reason,
    reportId: report.id,
    withdrawnAt: now.toISOString(),
  };

  const writes: Prisma.PrismaPromise<unknown>[] = [
    prisma.predictionCard.update({ where: { id: card.id }, data: { withdrawnAt: now } }),
    prisma.report.update({
      // 동시 요청 대비: PUBLISHED 조건을 다시 걸어 원자적으로 전이
      where: { id: report.id, status: 'PUBLISHED' },
      data: { status: 'CLOSED' },
    }),
    // 판정 불가(WITHDRAWN) 즉시 확정 → 전액 환불 지시서 + 당사자 알림까지 자동 경로와 동일
    ...buildJudgmentWrites(
      prisma,
      { ...card, report: { ...report, purchases: report.purchases } },
      {
        result: { outcome: 'UNDECIDABLE', undecidableReason: 'WITHDRAWN' },
        realizedReturnPct: null,
        score: 0, // 판정 불가는 표본 제외 (§2.2)
        info: 0, // 증거도 없다 — 규율 래더에 들어가면 안 된다
        dataSource: `takedown:${input.operatorUserId}`,
        audit,
      },
      now,
    ),
    // 사유가 담긴 별도 통지 — 리서처가 무엇을 고쳐야 하는지 알아야 재발이 줄어든다.
    // 신고 경로에서는 운영자가 직접 쓴 쪽지가 이 자리를 대신한다(notifyResearcher: false)
    ...(input.notifyResearcher === false
      ? []
      : [
          prisma.notification.create({
            data: {
              userId: report.researcher.userId,
              type: 'COMPLIANCE_TAKEDOWN',
              title: `운영자 강제 철회: ${report.title}`,
              body: `컴플라이언스 검토 결과 게시가 중단되었습니다. 사유: ${reason} · 구매자에게는 전액 환불되며 이 카드는 점수에 반영되지 않습니다.`,
              link: `/report/${report.id}`,
              createdAt: now,
            },
          }),
        ]),
    // 집행 결과를 검수 기록에 라벨로 남긴다.
    // 검수를 통과했던 건이면 이것이 미탐(놓친 위반)의 기록이 된다.
    ...(await operatorVerdictWrites(prisma, report.id, 'TAKEDOWN', input.operatorUserId, now, {
      reason,
      categories: input.categories,
      evidence: input.evidence,
    })),
  ];

  await prisma.$transaction(writes);

  return {
    reportId: report.id,
    refundedPurchases: report.purchases.length,
    refundedAmountKrw: report.purchases.reduce((sum, p) => sum + p.amountKrw, 0),
  };
}
