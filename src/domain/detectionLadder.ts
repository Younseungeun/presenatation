// 검출 항목 관리 — 승격/강등 사다리의 **추천** 로직 (2026-08-28, 회신 25호 답장 관문 설계).
//
// 검수 3층(학습표현·규칙·IRIS) 사이를 항목이 오가야 하는데, "지금 옮길 때가 됐나"를
// 증거로 판단한다. 이 파일은 **추천만** 낸다 — 실제 이동은 사람 몫(개발자가 규칙 쓰거나,
// IRIS 재학습 돌리거나). 실행 버튼은 화면에도 없다.
//
// ⚠ 문턱 숫자는 전부 **초안**이다 — 운영 실측 전이라 근거가 없다. 서버 세션 합의대로
// `@근거 설계` 초안 표식을 달고, 운영 표본이 쌓이면 재보정한다.

export type DetectionLayer = 'PHRASE' | 'RULE_WARN' | 'RULE_BLOCK' | 'IRIS';

/** 한 검출 항목(규칙 하나 또는 학습표현 하나)의 성적. 서버 집계가 채운다. */
export interface DetectionItemStats {
  /** ruleId (코드 규칙 id) 또는 `learned:<phraseId>` */
  id: string;
  label: string;
  layer: DetectionLayer;
  /** 이 항목이 걸린 검수 건 수 */
  matched: number;
  /** 정탐 — 걸렸고 운영자가 반려·철회로 확정 */
  truePos: number;
  /** 오탐 — 걸렸는데 운영자가 "오탐"으로 승인 (위임의 이유이자 IRIS 에게 가르칠 것) */
  falsePos: number;
  /**
   * 경미 — 걸렸고 지적은 타당하나 게시 막을 정도는 아니어서 승인 (12차 검토 C-5, 2026-09-01).
   * 오탐이 아니라 비활성화 사유는 아니지만, **승격 자격에는 비율 상한**을 건다 — 경미가
   * 대부분인 표현을 코드로 굳히면 성실한 리서처가 계속 보류 큐에 걸린다(λ=4).
   * 옛 문서의 "정탐 100%"는 사실이 아니었다 — 조건은 `오탐 0`뿐이라 전부 경미(정탐 0)도 통과했다
   */
  minorPos?: number;
  /**
   * 꼬리 연속 정탐 — 가장 최근 판정부터 거슬러 오탐·경미 없이 이어진 정탐 수 (12차 C-7).
   * 콜드스타트 프로필은 절대 건수 대신 이 값으로 "무결성"을 본다 — 운영 초기엔 100건을
   * 채우는 데 몇 달이 걸려 사다리가 안 움직인다
   */
  tailTruePosStreak?: number;
  /**
   * 출현형이 기록된 소견 수 — **규칙만** (12차 C-2). 2026-09-01 이전 소견엔 출현형이 없어
   * 표본이 이 값보다 적으면 형태 안정을 "모른다"로 두고 BLOCK 자격 판단에서 뺀다
   */
  surfaceSamples?: number;
  /** 항목 나이(일) — 학습표현 등록일 / 규칙은 미측정이면 undefined */
  ageDays?: number;
  /** 서로 다른 리서처 수 (5조건) — 학습표현만 */
  distinctResearchers?: number;
  /** 부정 문맥에서 걸린 hit 수 (5조건: 0이어야) — 학습표현만 */
  negationHits?: number;
  /**
   * 고유 표면형 수 (형태 안정성 판별자).
   * PHRASE 층은 등록 후 hit 의 표면형, **IRIS 층(졸업 표현)은 졸업 후 관찰의 표면형**이다 —
   * 졸업 전 표면형은 사전이 이미 흡수하던 variation 이라 반대 방향(강등)의 증거로 못 쓴다.
   */
  distinctSurfaces?: number;
  /** 최빈 표면형 점유율 0~1 (형태 안정성 판별자) — distinctSurfaces 와 같은 출처 */
  topSurfaceShare?: number;
  /**
   * IRIS 동반 검출 — **layer='PHRASE'만.** 이 항목이 걸린 확정 검수 건 중 IRIS(학생 —
   * 라이브 또는 그림자)도 같은 유형 소견을 낸 건수. 졸업(사전→IRIS)의 실증이다:
   * 내려도 잃는 것이 없으려면 IRIS 가 이미 잡고 있다는 영수증이 있어야 한다.
   */
  studentCoDetected?: number;
  /**
   * IRIS 미동반 — 이 항목이 걸린 확정 건 중 IRIS 가 같은 유형을 못 낸 건수.
   * 하나라도 있으면 사전이 하중을 지는 것이라 졸업 불가. 학생 기록이 아예 없어
   * 알 수 없는 건도 여기로 센다(모르면 내리지 않는다 — 보수 방향).
   */
  studentMissed?: number;
  /**
   * 그림자 정탐 중 **IRIS 는 놓친** 건수 — **layer='IRIS'(졸업 표현)만.**
   * 복귀(IRIS→사전)의 실증이다: 옛 항목이 잡는다는 것만으로는 부족하고(IRIS 도 잡으면
   * 중복이라 되살릴 이유가 없다), IRIS 가 놓친 확정 위반을 옛 항목이 잡았을 때만
   * 복귀가 실제 보호 구멍을 메운다 (2026-08-31 창업자 지적).
   */
  missTruePos?: number;
  /**
   * 관찰된 표면형 예시 (빈도 상위 몇 개) — **layer='IRIS'(졸업 표현)만.**
   * 졸업 강등 추천의 사유에 "이 표현이 어떤 형태들로 나타났는가"를 그대로 싣기 위한
   * 근거 자료다(2026-08-31 창업자 지적: 추천은 "어떤 variation 을 코드가 서술하는가"를
   * 말해야 한다). 트리거 조건이 아니라 표시용이다.
   */
  surfaceExamples?: string[];
  /**
   * 졸업 관찰에서 IRIS 가 놓친 **총** 횟수 — **layer='IRIS'(졸업한 표현)만.**
   * `GraduationWatchHit.studentFlagged=false` 의 집계다 (판정 유무 무관).
   *
   * ⚠ 미탐 총수 자체는 트리거가 아니다 — IRIS 의 실패는 재학습(수리)의 신호이고, 여기
   * 실리는 이유는 표시·재학습 재료 집계다. 복귀 트리거는 이 중 **사람이 위반으로 확정한
   * 부분집합**(missTruePos)만 쓴다 — 미탐이 "확정 위반의 미탐"일 때만 구멍의 실증이다.
   */
  studentMissCount?: number;
}

/**
 * 이동의 두 축 (2026-08-31 창업자 어휘 확정):
 *  · **축 내(승격)** — 같은 입력 매칭 축 안에서 위로. 조건 = 문맥 조건 코드화의 완결성
 *  · **축 간(졸업/졸업 강등)** — 매칭 축 ↔ IRIS(의미 추론). 상하가 아니라 **방식 교체**다:
 *    형태 매칭과 의미 추론은 잡는 원리가 달라, 어느 쪽이 이 항목에 효과적인가로 정한다
 */
export type LadderRecommendationKind =
  | 'PROMOTE_RULE' // [축 내 승격] 학습표현 → 규칙 WARN (형태 굳음 = 코드화 가능)
  | 'PROMOTE_BLOCK' // [축 내 승격] 규칙 WARN → BLOCK (관찰 자격 충족 — 스트레스 시험·승인은 사람)
  | 'GRADUATE_IRIS' // [축 간 졸업] 학습표현 → IRIS (5조건 + IRIS 동반 검출 실증 = 중복이라 내려도 안전)
  | 'DELEGATE_IRIS' // [축 간 졸업 — 문맥 위임] 규칙 → IRIS (오탐 = 형태는 맞는데 문맥을 못 가름)
  | 'UNGRADUATE'; // [축 간 졸업 강등 — 복귀 지름길만] 졸업했던 사전 항목의 재활성 후보 (그림자 실적).
//                    졸업 강등의 본선(아직 코드화 안 된 것을 논의로 설계해 내리기)은 자동 추천이
//                    원리적으로 불가능하다 — 코드화가 존재하기 전에는 잴 것이 없다. 그 몫은 질문지의
//                    관할 재검토 논의다 (teacherPack.caseGuide)

export interface LadderRecommendation {
  kind: LadderRecommendationKind;
  reason: string;
}

/**
 * @근거 설계 관문 문턱 초안 (회신 25호 답장). 운영 실측 전이라 전부 초안 — 표본이 쌓이면
 * 재보정한다. 개별 숫자의 근거:
 *  · 5조건(걸림30·정탐100%·30일·리서처5·부정0) = 졸업 후보와 동일 잣대(두 출구가 같아야)
 *  · 형태 안정(≤3종·최빈≥80%) = "늘 같은 꼴로 온다"의 초안 경계
 *  · BLOCK 관찰(100건·90일) = rule of three 로 오탐률 상한 ~3% (필요조건, 충분조건은 사람)
 *  · 위임 표본 하한 20 = IRIS 가 무엇을 이어받는지조차 실측 못 하는 규칙은 위임감 아님
 *  · 복귀 미탐-정탐 하한 2 = "IRIS 가 놓친 확정 위반을 옛 항목이 잡음"이 2건은 있어야
 *    패턴이다 — 1건은 그 판정·신고 자체가 오판일 수 있다 (X-5 원칙과 같은 이유)
 */
export const LADDER_THRESHOLDS = {
  phraseMinMatched: 30,
  phraseMinAgeDays: 30,
  phraseMinResearchers: 5,
  formMaxSurfaces: 3,
  formMinTopShare: 0.8,
  blockMinMatched: 100,
  blockMinAgeDays: 90,
  delegateMinMatched: 20,
  ungraduateMinMissTruePos: 2,
  /**
   * 경미 비율 상한 (12차 검토 C-5 채택, 2026-09-01) — 경미/(정탐+경미) 가 이 위면 승격·졸업
   * 후보에서 뺀다. 20% 는 검토자 제안값 — "다섯 번 걸리면 한 번은 지적만 맞고 게시는 됐다"가
   * 코드로 굳히기엔 성가신 경계라는 경험칙. 실측 후 재보정
   */
  phraseMaxMinorShare: 0.2,
  /**
   * 졸업 추천의 IRIS 동반 검출 최소 건수 (12차 검토 C-1 반채택, 2026-09-01) — 동반 1/1 로는
   * 우연이다. 5건은 "IRIS 가 이 표현을 잡는다"를 패턴이라 부를 최소치(복귀 2건보다 높은 이유:
   * 내리는 쪽이 보호를 빼는 결정이라 더 보수). 사람 버튼은 잠그지 않고 경고만(창업자 확정)
   */
  graduateMinCoDetected: 5,
  /**
   * 규칙의 형태 안정을 판단할 최소 출현형 표본 (12차 C-2). 출현형 기록은 2026-09-01 부터라
   * 그 전 소견만 있는 규칙은 표본이 0 — 모르면 BLOCK 자격에서 형태 조건을 빼고 종전대로 본다.
   * 20 은 표면형 ≤3종·최빈 ≥80% 를 우연이 아니라고 부를 최소치(초안)
   */
  blockMinSurfaceSamples: 20,
} as const;

/**
 * 문턱 프로필 — 표준(절대 건수) 또는 콜드스타트(연속 정탐). `streak` 가 있으면 물량 조건을
 * "걸림 ≥N" 대신 "꼬리 연속 정탐 ≥N" 으로 본다. 나머지(오탐 0·경미 상한·리서처 수·부정 0·
 * 형태)는 두 프로필이 같다 — 무결성을 다른 방식으로 증명할 뿐, 요구를 낮추는 것이 아니다
 */
export type LadderThresholds = { [K in keyof typeof LADDER_THRESHOLDS]: number } & {
  streak?: { phrase: number; block: number };
};

/**
 * @근거 설계 콜드스타트 프로필 (12차 검토 C-7 채택, 2026-09-01) — 운영 초기 6개월 한정.
 * 검토자 제안값: 사전→WARN 연속 정탐 10, WARN→BLOCK 연속 정탐 30 + 30일. 절대 건수는 초기에
 * 몇 달이 걸려 사다리가 한 번도 안 움직이는데, 연속 정탐은 "표본이 적어도 무결한가"를
 * 증명한다. **리서처 수 하한(5)은 그대로** — 한 사람 10장으로 승격되면 안 된다.
 * AppSetting `ladder.coldstart` 로 켜고 끈다(배포 없이).
 */
export const LADDER_THRESHOLDS_COLDSTART: LadderThresholds = {
  ...LADDER_THRESHOLDS,
  blockMinAgeDays: 30,
  streak: { phrase: 10, block: 30 },
};

/** 경미 비율 — 정탐+경미 중 경미. 표본이 없으면 0 (조건을 막지 않는다) */
export function minorShare(s: Pick<DetectionItemStats, 'truePos' | 'minorPos'>): number {
  const minor = s.minorPos ?? 0;
  const denom = s.truePos + minor;
  return denom === 0 ? 0 : minor / denom;
}

/** 물량 조건 — 표준은 절대 건수, 콜드스타트는 꼬리 연속 정탐 (C-7) */
function volumeOk(s: DetectionItemStats, minMatched: number, minStreak: number | undefined): boolean {
  return minStreak == null ? s.matched >= minMatched : (s.tailTruePosStreak ?? 0) >= minStreak;
}

const pct = (v: number) => Math.round(v * 100);

/**
 * 항목 하나의 추천 이동을 낸다 (없으면 null). **추천만** — 실행은 사람.
 * 오탐이 있으면 승격 후보 자격이 자동 소멸한다(Q-D: 상충 정의상 제거).
 */
export function recommendMigration(
  s: DetectionItemStats,
  T: LadderThresholds = LADDER_THRESHOLDS,
): LadderRecommendation | null {

  if (s.layer === 'PHRASE') {
    // 5조건 — 졸업 후보와 같은 잣대. 하나라도 못 채우면 아직 아무 출구도 아니다
    const fiveConditions =
      volumeOk(s, T.phraseMinMatched, T.streak?.phrase) &&
      s.falsePos === 0 &&
      (s.ageDays ?? 0) >= T.phraseMinAgeDays &&
      (s.distinctResearchers ?? 0) >= T.phraseMinResearchers &&
      (s.negationHits ?? 0) === 0 &&
      // 경미 비율 상한 (C-5) — 전부 경미(정탐 0)인 표현이 승격 후보가 되던 구멍
      minorShare(s) <= T.phraseMaxMinorShare;
    if (!fiveConditions) return null;
    // 형태가 굳었으면 규칙 승격이 우선이다 — 규칙(→BLOCK)은 IRIS 가 절대 갖지 못하는
    // 즉시 거절로 가는 유일한 길이라, IRIS 가 중복으로 잡고 있더라도 이 길이 더 값지다
    const formStable =
      (s.distinctSurfaces ?? 99) <= T.formMaxSurfaces &&
      (s.topSurfaceShare ?? 0) >= T.formMinTopShare;
    if (formStable) {
      return {
        kind: 'PROMOTE_RULE',
        reason: `5조건 통과 · 형태 안정(표면형 ${s.distinctSurfaces ?? '—'}종·최빈 ${pct(s.topSurfaceShare ?? 0)}%)`,
      };
    }
    // **졸업의 판별자는 "형태 다양"이 아니라 "IRIS 동반 검출 실증"이다** (2026-08-31
    // 창업자 지적으로 교체). 사전 hit 에 남는 다양한 표면형은 전부 **엔진이 잡은**
    // 형태라, 다양성은 "뜻으로 잡아야"의 증거가 아니라 사전 항목 하나가 그 variation 을
    // 이미 서술한다는 증거다 — 옛 판별자는 사전이 가장 잘 작동하는 순간에 그 사전을
    // 껐고, 그렇게 내려간 항목이 그림자 실적으로 되돌아오는 왕복을 만들었다.
    //
    // 사전 항목을 내리는 것은 보호를 하나 빼는 결정이므로, 정당하려면 **잃는 것이
    // 없다는 영수증**이 필요하다: 이 항목이 잡은 확정 건들에서 IRIS 도 같은 유형을
    // 냈는가(동반 검출). 미동반이 하나라도 있으면 사전이 하중을 지고 있는 것이고,
    // 실증이 아예 없으면(동반 0·미동반 0) 모르는 것이므로 내리지 않는다.
    // 동반 1/1 은 우연이다 — 최소 건수(C-1)를 넘어야 "IRIS 가 잡는다"가 패턴이 된다
    if ((s.studentMissed ?? 1) === 0 && (s.studentCoDetected ?? 0) >= T.graduateMinCoDetected) {
      return {
        kind: 'GRADUATE_IRIS',
        reason:
          `5조건 통과 · IRIS 동반 검출 ${s.studentCoDetected}건/미동반 0 — 중복 실증, ` +
          `내려도 잃는 것 없음 (사전 슬림화)`,
      };
    }
    // 형태 다양 + IRIS 미커버(또는 미실증): 이 variation 을 잡는 유일한/실증된 층이
    // 사전이다 — 이동할 이유가 없다. 미동반 건은 IRIS 재학습 재료가 된다
    return null;
  }

  if (s.layer === 'RULE_WARN') {
    // 오탐이 있으면 승격 자격 소멸 — 그건 "형태는 맞는데 문맥을 못 가른다" = IRIS감.
    // 실패가 아니라 **관할 이전**이다(축 간 이동 = 졸업 계열) — 형태 매칭이 못 가르는
    // 문맥은 의미 추론의 몫이라, 위로 못 간 것이 아니라 옆 축으로 보낼 때가 된 것이다
    if (s.falsePos > 0) {
      return s.matched >= T.delegateMinMatched
        ? { kind: 'DELEGATE_IRIS', reason: `오탐 ${s.falsePos}건 — 문맥 못 가름, IRIS 위임(졸업) 검토` }
        : null; // 표본 하한 미달 — 위임 논의도 이르다
    }
    // 오탐 0 — BLOCK 관찰 자격(문·자격·승인 중 관찰 몫만). 스트레스 시험·승인은 사람
    // 형태 안정 (C-2) — 출현형 표본이 충분할 때만 판단한다. 흔들리는 꼴을 즉시 거절로 올리면
    // 오탐 위험이 크다(BLOCK 은 되돌릴 사람이 없다). 표본이 모자라면(도입 전 기록) 모르는 것이라
    // 종전대로 본다 — 모른다고 막지 않고, 모른다고 통과시키지도 않는 게 아니라 **측정된 것만** 쓴다
    const formKnown = (s.surfaceSamples ?? 0) >= T.blockMinSurfaceSamples;
    const formStableRule =
      !formKnown ||
      ((s.distinctSurfaces ?? 99) <= T.formMaxSurfaces && (s.topSurfaceShare ?? 0) >= T.formMinTopShare);
    if (
      volumeOk(s, T.blockMinMatched, T.streak?.block) &&
      (s.ageDays ?? 0) >= T.blockMinAgeDays &&
      // 경미가 잦은 규칙은 BLOCK 감이 아니다 (C-5) — 즉시 거절이 "지적만 맞는" 글을 죽인다
      minorShare(s) <= T.phraseMaxMinorShare &&
      formStableRule
    ) {
      return {
        kind: 'PROMOTE_BLOCK',
        reason: `오탐 0 · ${s.matched}건/${s.ageDays}일 관찰 충족 — 부정 스트레스 시험·그림자 BLOCK·승인 남음`,
      };
    }
    return null;
  }

  if (s.layer === 'IRIS') {
    // **여기서 자동 추천이 다루는 것은 졸업 강등의 좁은 지름길 하나뿐이다** (2026-08-31
    // 창업자 지적으로 범위 정정): **졸업했던 사전 항목의 복귀(재활성)**. 이 케이스만
    // 코드화(사전 항목)가 이미 존재해서 잴 것이 있다 — 그림자 재생(recordGraduationWatch
    // 가 applyRules 를 재생해 남기는 관찰)으로 "IRIS 가 놓친 확정 위반을 옛 항목이
    // 잡는가"를 실적으로 확인한다 — 잡는 것만으로는 부족하다(IRIS 도 잡으면 중복이다).
    //
    // **졸업 강등의 본선은 여기 없다.** 본선 = 아직 코드화 안 된 표현(IRIS 가 잡거나
    // 놓치는 것)을 "이 variation 들을 이런 표현·문맥 조건으로 적으면 규칙이 잡는다"고
    // **설계해서** 내리는 것 — 코드화가 존재하기 전에는 잴 것이 없으므로 자동 추천이
    // 원리적으로 불가능하고, 그 설계는 재학습 질문지의 관할 재검토 논의가 맡는다
    // (teacherPack.caseGuide). 실행은 학습 표현 등록 또는 코드 규칙 작성이다.
    //
    // 복귀의 실증은 두 사실의 **교집합**이다 (2026-08-31 창업자 지적 — 한쪽만으로는
    // 안 된다):
    //   · 옛 항목이 잡는다 — 그림자 재생이 확정 위반을 잡았다 (잡는 쪽 실증)
    //   · **IRIS 는 그걸 놓쳤다** — 같은 건에서 학생이 침묵했다 (구멍 실증)
    // IRIS 도 다 잡고 있으면(미탐 0) 옛 항목은 중복이라 되살릴 이유가 없다 — 그건
    // 졸업이 옳았다는 증거다. 반대로 미탐-정탐이 쌓이면, 복귀가 실제 보호 구멍을 메운다.
    //   · 그림자 오탐 = 0 은 그대로 요구한다 — 되살려도 정상 리포트를 잡지 않아야 한다
    //
    // 미탐 "자체"는 여전히 재학습 신호이기도 하다 — 복귀는 즉시 보호를 복구하는 처방,
    // 재학습은 IRIS 를 고치는 처방으로 병행된다(둘은 배타가 아니다).
    if ((s.missTruePos ?? 0) >= T.ungraduateMinMissTruePos && s.falsePos === 0) {
      const examples = (s.surfaceExamples ?? [])
        .slice(0, 3)
        .map((x) => `“${x}”`)
        .join(' · ');
      const more = (s.distinctSurfaces ?? 0) > 3 ? ' 외' : '';
      return {
        kind: 'UNGRADUATE',
        reason:
          `IRIS 가 놓친 확정 위반 ${s.missTruePos}건을 옛 사전 항목이 잡음(그림자 오탐 0` +
          `${examples ? ` · 표면형 ${s.distinctSurfaces ?? 0}종: ${examples}${more}` : ''}) — ` +
          `복귀하면 이 구멍이 메워짐, 확정은 사람. 신규 코드화 강등은 질문지 논의의 몫 (졸업 강등)`,
      };
    }
    return null;
  }

  // RULE_BLOCK 은 이 화면에서 더 올릴 곳이 없다 (BLOCK 은 축 내 최상단.
  // BLOCK→WARN 하강은 자동 추천이 원리적으로 불가능하다 — 즉시 거절은 큐에 안 남아
  // 오탐 증거 채널이 없다. 리서처 이의·평가셋 회귀로 사람이 코드 리뷰에서 판단한다)
  return null;
}
