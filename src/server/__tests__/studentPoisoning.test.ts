import { beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Finding } from '@/domain/compliance';
import type { LabeledReview } from '@/domain/screeningAccuracy';
import {
  ROLLBACK_COST_RATIO,
  ROLLBACK_WINDOW,
  studentRollbackStatus,
  WILSON_MIN_SAMPLE,
  wilsonLowerBound,
} from '@/domain/studentRollback';
import type { StudentClient } from '@/infra/compliance/studentClient';
import { resolveLiveStudent } from '../complianceService';
import { readCoverageSnapshot } from '@/domain/coverageMargin';
import {
  canReleaseAutoShadow,
  engageAutoShadow,
  evaluateAutoShadow,
  isAutoShadowed,
  releaseAutoShadow,
  resetAutoShadowCache,
} from '../studentAutoShadow';

// **합성 오염으로 자동 롤백을 격발시킨다** (10차 검토 I-6).
//
// 검토가 정한 완성 조건: 진짜 리포트를 기다리지 말고, 오탐이 의도적으로 섞인 가짜
// 트래픽을 주입해서 **사람의 개입 없이 스스로 격발되는지**, 그리고 그 격발 지점이
// **수학적 기대치와 일치하는지**를 확인하라.
//
// 기대치는 이 파일 안에서 **따로 센다** — studentRollbackStatus를 불러 비교하면
// 같은 코드로 같은 코드를 채점하는 것이라 아무것도 증명하지 못한다.

/** 재측정 주기(5분)보다 길게 — 주입 한 건마다 다시 재게 한다 */
const EVAL_STEP_MS = 6 * 60_000;
const T0 = 1_700_000_000_000;

function finding(source: Finding['source']): Finding {
  return { category: 'PRIVATE_INFO', severity: 'WARN', quote: '', reason: '합성', source };
}

/** 학생이 소견을 낸 건 — 운영자가 반려하면 정탐, 승인하면 오탐 */
function studentReview(falsePositive: boolean): LabeledReview {
  return {
    decision: 'WARN',
    findings: [finding('student')],
    verdict: falsePositive ? 'APPROVED' : 'REJECTED',
    findingsValid: falsePositive ? false : null,
    actualCategories: [],
  };
}

/**
 * 학생이 지적했고 운영자가 **아무 표시 없이** 승인한 건 (11차 K-1).
 * 정확도 지표에서는 오탐으로 세지만, 격하 판정에서는 **표본이 아니다** —
 * "모델이 틀렸다"가 아니라 "운영자가 말하지 않았다"이기 때문이다.
 */
function silentApproval(): LabeledReview {
  return {
    decision: 'WARN',
    findings: [finding('student')],
    verdict: 'APPROVED',
    findingsValid: null,
    actualCategories: [],
  };
}

/** 학생이 아무 말도 안 한 건 — 규칙만 지적했다. 학생의 성적이 아니다 */
function ruleOnlyReview(): LabeledReview {
  return {
    decision: 'WARN',
    findings: [finding('rule')],
    verdict: 'APPROVED',
    findingsValid: false,
    actualCategories: [],
  };
}

/** AppSetting 한 장짜리 가짜 DB */
function fakePrisma() {
  const store = new Map<string, { value: string; updatedBy: string | null }>();
  let broken = false;
  const prisma = {
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        if (broken) throw new Error('DB 흔들림');
        return store.get(where.key) ?? null;
      },
      upsert: async ({
        where,
        update,
        create,
      }: {
        where: { key: string };
        update: { value: string; updatedBy: string };
        create: { value: string; updatedBy: string };
      }) => {
        const next = store.has(where.key)
          ? { value: update.value, updatedBy: update.updatedBy }
          : { value: create.value, updatedBy: create.updatedBy };
        store.set(where.key, next);
        return next;
      },
    },
  } as unknown as PrismaClient;
  return { prisma, store, breakDb: () => (broken = true) };
}

/**
 * **오염된 트래픽 100건.**
 * 40번째부터 두 건에 한 건씩 오탐 — 학생이 어느 날부터 나빠진 상황을 흉내 낸다.
 * 앞 40건이 전부 정탐이라, 창(50건)이 물갈이되는 동안 순이익이 서서히 적자로 넘어간다.
 * 처음부터 전부 오탐이면 첫 25건에서 바로 걸려 "언제 넘어가는가"를 못 본다.
 */
const POISON_START = 40;
const isPoisoned = (i: number) => i >= POISON_START && i % 2 === 0;

/**
 * 검토가 요구한 "수학적 기대치" — 순수 함수를 부르지 않고 여기서 직접 센다.
 * 11차 K-2 이후 관문이 둘이라 **양쪽을 다 센다**: 표본이 창의 절반을 넘으면
 * 순이익, 그 아래면 오탐률의 95% 하한.
 */
function expectedTriggerIndex(): number {
  const half = Math.ceil(ROLLBACK_WINDOW / 2);
  const breakEven = 1 / (1 + ROLLBACK_COST_RATIO);
  for (let n = 0; n < 100; n += 1) {
    const from = Math.max(0, n - ROLLBACK_WINDOW + 1);
    let caught = 0;
    let fp = 0;
    for (let i = from; i <= n; i += 1) {
      if (isPoisoned(i)) fp += 1;
      else caught += 1;
    }
    const scored = caught + fp;
    if (scored >= half) {
      if (caught - ROLLBACK_COST_RATIO * fp < 0) return n;
    } else if (scored >= WILSON_MIN_SAMPLE) {
      if (wilsonLowerBound(fp, scored) > breakEven) return n;
    }
  }
  return -1;
}

describe('합성 오염 → 자동 롤백 격발 (10차 I-6)', () => {
  beforeEach(() => resetAutoShadowCache());

  it('사람의 개입 없이 스스로 격발하고, 그 지점이 수학적 기대치와 일치한다', async () => {
    const { prisma, store } = fakePrisma();
    const history: LabeledReview[] = []; // 최신순
    let firedAt = -1;

    for (let n = 0; n < 100; n += 1) {
      history.unshift(studentReview(isPoisoned(n)));
      const { engaged } = await evaluateAutoShadow(prisma, history, new Date(T0 + n * EVAL_STEP_MS));
      if (engaged && firedAt < 0) firedAt = n;
    }

    const expected = expectedTriggerIndex();
    // 기대치 자체가 성립하는 시나리오인지 먼저 본다 — 한 번도 안 걸리는 트래픽으로
    // "일치했다"고 말하면 아무것도 증명하지 못한다
    expect(expected).toBeGreaterThan(0);
    expect(firedAt).toBe(expected);
    expect(store.get('student.auto_shadow')?.value).toBe('1');
    // 시스템이 걸었다는 표식이 남아야 사람이 건 것과 갈린다
    expect(store.get('student.auto_shadow')?.updatedBy).toBe('system:student-rollback');
  });

  it('오탐이 없으면 100건을 흘려도 격발하지 않는다 — 트래픽 자체에 반응하는 장치가 아니다', async () => {
    const { prisma, store } = fakePrisma();
    const history: LabeledReview[] = [];
    for (let n = 0; n < 100; n += 1) {
      history.unshift(studentReview(false));
      const { engaged } = await evaluateAutoShadow(prisma, history, new Date(T0 + n * EVAL_STEP_MS));
      expect(engaged).toBe(false);
    }
    expect(store.has('student.auto_shadow')).toBe(false);
  });

  // ── 11차 K-2: 출시 직후에도 명백한 신호는 25건을 기다리지 않는다 ──────
  //
  // 10차까지는 표본이 창의 절반(25건)을 채워야만 격발했다. 그런데 출시 초에는 그
  // 25건이 몇 주 걸린다 — **가장 위험한 시기에 안전망이 구조적으로 죽어 있었다.**
  // 그렇다고 단순 비율로 판정하면 3건 중 1건에 껐다 켰다 하는 반사신경이 된다.
  // 윌슨 하한은 표본이 적으면 저절로 보수적이 되고 쌓일수록 단순 비율에 수렴한다.
  it('명백한 신호는 창의 절반을 기다리지 않는다 — 5건 중 4건이면 격발', async () => {
    const { prisma } = fakePrisma();
    const rows = [
      ...Array.from({ length: 4 }, () => studentReview(true)),
      studentReview(false),
    ];
    const r = await evaluateAutoShadow(prisma, rows, new Date(T0));
    expect(r.status?.scored).toBe(5);
    expect(r.status?.basis).toBe('wilson');
    expect(r.engaged).toBe(true);
  });

  it('오탐 한두 건에는 흔들리지 않는다 — 5건 중 2건은 유지', async () => {
    const { prisma } = fakePrisma();
    const rows = [
      ...Array.from({ length: 2 }, () => studentReview(true)),
      ...Array.from({ length: 3 }, () => studentReview(false)),
    ];
    const r = await evaluateAutoShadow(prisma, rows, new Date(T0));
    expect(r.status?.basis).toBe('wilson');
    expect(r.engaged).toBe(false);
  });

  it('한 건으로는 판단하지 않는다 — 모델이 나쁜 것과 그 리포트가 유별난 것이 안 갈린다', async () => {
    const { prisma } = fakePrisma();
    const r = await evaluateAutoShadow(prisma, [studentReview(true)], new Date(T0));
    expect(r.status?.basis).toBe('insufficient');
    expect(r.engaged).toBe(false);
    // 하한식만 두면 여기서 격발한다(0.207 > 0.2) — 최소 표본이 그 자리를 막는다
    expect(wilsonLowerBound(1, 1)).toBeGreaterThan(1 / (1 + ROLLBACK_COST_RATIO));
    expect(WILSON_MIN_SAMPLE).toBeGreaterThan(1);
  });

  // ── 11차 K-1: 무심코 누른 승인은 표본이 아니다 ────────────────────────
  //
  // 10차에는 이 시나리오가 순이익 −100 으로 학생을 영구히 껐다. 큐가 밀린 날
  // 스무 건을 빠르게 승인하는 것은 정상 운영인데, 그날 모델이 내려갔다.
  it('아무 표시 없는 승인만 25건이면 격발하지 않는다 (10차 결함)', async () => {
    const { prisma, store } = fakePrisma();
    const silent = Array.from({ length: 25 }, () => silentApproval());
    const r = await evaluateAutoShadow(prisma, silent, new Date(T0));
    expect(r.status?.scored).toBe(0);
    expect(r.status?.basis).toBe('insufficient');
    expect(r.engaged).toBe(false);
    expect(store.has('student.auto_shadow')).toBe(false);
  });

  it('그중 여섯 건을 명시적으로 신고하면 격발한다 — 의도된 신호는 그대로 산다', async () => {
    const { prisma } = fakePrisma();
    const rows = [
      ...Array.from({ length: 6 }, () => studentReview(true)),
      ...Array.from({ length: 19 }, () => silentApproval()),
    ];
    const r = await evaluateAutoShadow(prisma, rows, new Date(T0));
    expect(r.status?.scored).toBe(6);
    expect(r.status?.falsePositives).toBe(6);
    expect(r.engaged).toBe(true);
  });

  // ── 이 스레드가 이번에 배운 것: **개입이 관측을 지운다** ──────────────
  it('격하된 뒤에는 스스로 풀리지 않는다 — 순진한 구현이라면 여기서 발진한다', async () => {
    const { prisma } = fakePrisma();
    await engageAutoShadow(prisma, '합성 시험', new Date(T0));
    expect(await isAutoShadowed(prisma, T0)).toBe(true);

    // 격하 뒤의 세상: 학생이 소견을 안 내므로 창이 규칙 전용 기록으로 채워진다.
    const after = Array.from({ length: ROLLBACK_WINDOW }, () => ruleOnlyReview());

    // 같은 창을 순이익 함수에 물으면 "끌 이유 없음"이라고 답한다 —
    // **좋아져서가 아니라 잴 재료가 없어서**인데, 두 경우의 답이 같은 얼굴로 나온다.
    expect(studentRollbackStatus(after).scored).toBe(0);
    expect(studentRollbackStatus(after).shouldRollback).toBe(false);

    // 그래서 걸쇠가 필요하다. 매번 다시 재서 켜고 끄는 구현이라면 여기서 다시 켜지고,
    // 켜지면 다시 오탐이 쌓여 또 꺼진다 — 껐다 켰다가 영원히 반복된다.
    resetAutoShadowCache();
    expect(await isAutoShadowed(prisma, T0 + 100_000)).toBe(true);
  });

  // ── 11차 K-4: 해제도 문턱을 지난다 ──────────────────────────────────
  //
  // 10차의 유일한 문턱은 확인 창 하나였다("재채택을 통과시켰습니까?"). 그 질문에
  // 답하는 사람과 답을 검증할 수 있는 사람이 같으면 그것은 문턱이 아니라 인사말이다.
  // 검사하는 것은 **증거의 신선도** 하나 — 채택 판정을 통과한 가중치와 지금 서빙
  // 중인 가중치가 같은가.
  it('지금 서빙 중인 가중치가 채택 판정을 통과한 것과 같아야 풀린다', async () => {
    const snapshot = readCoverageSnapshot();
    expect(snapshot).not.toBeNull();
    await expect(canReleaseAutoShadow(snapshot!.modelSha)).resolves.toMatchObject({ ok: true });
  });

  it('다른 가중치를 서빙 중이면 막는다 — 그 모델은 채택선을 통과한 적이 없다', async () => {
    const gate = await canReleaseAutoShadow('0000000000000000');
    expect(gate.ok).toBe(false);
    // 사유가 없는 거부는 진단을 지운다 (9차에 정한 규율)
    expect(gate.reason).toContain('0000000000000000');
  });

  it('사이드카가 무엇을 서빙 중인지 모르면 막는다', async () => {
    await expect(canReleaseAutoShadow(null)).resolves.toMatchObject({ ok: false });
  });

  it('사람이 풀면 풀리고, 누가 풀었는지 남는다', async () => {
    const { prisma, store } = fakePrisma();
    await engageAutoShadow(prisma, '합성 시험', new Date(T0));
    await releaseAutoShadow(prisma, 'operator-1', new Date(T0 + 100_000));
    expect(store.get('student.auto_shadow')?.value).toBe('0');
    expect(store.get('student.auto_shadow')?.updatedBy).toBe('operator-1');
    resetAutoShadowCache();
    expect(await isAutoShadowed(prisma, T0 + 200_000)).toBe(false);
  });

  it('같은 격하를 두 번 걸지 않는다 — 매 건 알림이 나가면 경보 피로가 된다', async () => {
    const { prisma } = fakePrisma();
    expect(await engageAutoShadow(prisma, '첫 번째', new Date(T0))).toBe(true);
    expect(await engageAutoShadow(prisma, '두 번째', new Date(T0))).toBe(false);
  });

  it('재측정 주기 안에서는 다시 재지 않는다 — 리포트마다 200건을 읽지 않는다', async () => {
    const { prisma } = fakePrisma();
    const poisoned = Array.from({ length: ROLLBACK_WINDOW }, () => studentReview(true));
    expect((await evaluateAutoShadow(prisma, poisoned, new Date(T0))).evaluated).toBe(true);
    const soon = await evaluateAutoShadow(prisma, poisoned, new Date(T0 + 60_000));
    expect(soon.evaluated).toBe(false);
    expect(soon.status).toBeNull();
  });

  it('DB가 흔들려도 게시를 막지 않는다 — 걸쇠를 못 읽으면 격하 아님으로 답한다', async () => {
    const { prisma, breakDb } = fakePrisma();
    breakDb();
    await expect(isAutoShadowed(prisma, T0)).resolves.toBe(false);
    await expect(
      evaluateAutoShadow(prisma, [studentReview(true)], new Date(T0)),
    ).resolves.toBeTruthy();
  });
});

// ── 걸쇠가 실제로 라이브 진입을 막는가 (배선 시험) ────────────────────
//
// 걸쇠도 usable()도 각각 시험이 있었지만, **둘을 어떻게 엮었는가**는 예전에
// screenAndRecord 안의 한 줄이라 아무도 붙잡지 않았다. 8차에 비싸게 배운 모양이다:
// 각 파일이 자기 안에서 옳아도 시스템은 틀릴 수 있다.

function fakeClient(over: Partial<StudentClient> = {}) {
  let asked = 0;
  const client: StudentClient = {
    reviewerId: 'student:test@t0.5/L7',
    health: async () => null,
    screen: async () => null,
    consumeAvailabilityChange: () => null,
    usable: async () => {
      asked += 1;
      return true;
    },
    ...over,
  };
  return { client, usableCalls: () => asked };
}

describe('라이브 진입 관문 (10차 I-6 배선)', () => {
  beforeEach(() => resetAutoShadowCache());

  it('걸쇠가 걸려 있으면 라이브로 못 간다 — STUDENT_MODE=live 여도', async () => {
    const { prisma } = fakePrisma();
    await engageAutoShadow(prisma, '합성 시험', new Date(T0));
    const { client } = fakeClient();
    // 걸쇠는 **의도된 격하**라 장애(outage)가 아니다 — Q0 정책에서 이 구별이 게시 보류
    // 여부를 가른다 (studentOutage.test.ts 가 그 정책 쪽을 잡는다)
    await expect(resolveLiveStudent(prisma, 'live', client)).resolves.toEqual({
      client: undefined,
      outage: false,
    });
  });

  it('걸쇠가 걸려 있으면 사이드카에게 묻지도 않는다', async () => {
    const { prisma } = fakePrisma();
    await engageAutoShadow(prisma, '합성 시험', new Date(T0));
    const { client, usableCalls } = fakeClient();
    await resolveLiveStudent(prisma, 'live', client);
    // 순서에 뜻이 있다 — 격하된 동안에는 물어볼 이유가 없다
    expect(usableCalls()).toBe(0);
  });

  it('걸쇠가 없으면 지문·카나리아 판정이 최종이다', async () => {
    const { prisma } = fakePrisma();
    const ok = fakeClient();
    await expect(resolveLiveStudent(prisma, 'live', ok.client)).resolves.toEqual({
      client: ok.client,
      outage: false,
    });
    expect(ok.usableCalls()).toBe(1);

    resetAutoShadowCache();
    // usable() 실패는 **장애**다 — outage:true 가 runScreening 에서 UNAVAILABLE 보류가 된다
    const bad = fakeClient({ usable: async () => false });
    await expect(resolveLiveStudent(prisma, 'live', bad.client)).resolves.toEqual({
      client: undefined,
      outage: true,
    });
  });

  it('모드가 라이브가 아니면 걸쇠도 사이드카도 묻지 않는다', async () => {
    const { prisma } = fakePrisma();
    const { client, usableCalls } = fakeClient();
    const idle = { client: undefined, outage: false };
    await expect(resolveLiveStudent(prisma, 'shadow', client)).resolves.toEqual(idle);
    await expect(resolveLiveStudent(prisma, 'off', client)).resolves.toEqual(idle);
    await expect(resolveLiveStudent(prisma, 'live', null)).resolves.toEqual(idle);
    expect(usableCalls()).toBe(0);
  });

  it('사람이 풀면 다시 라이브로 간다', async () => {
    const { prisma } = fakePrisma();
    await engageAutoShadow(prisma, '합성 시험', new Date(T0));
    await releaseAutoShadow(prisma, 'operator-1', new Date(T0 + 100_000));
    resetAutoShadowCache();
    const { client } = fakeClient();
    await expect(resolveLiveStudent(prisma, 'live', client)).resolves.toEqual({
      client,
      outage: false,
    });
  });
});
