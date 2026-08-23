import { describe, expect, it } from 'vitest';
import type { Finding, ScreeningInput } from '@/domain/compliance';
import type {
  StudentClient,
  StudentHealth,
  StudentOutput,
} from '@/infra/compliance/studentClient';
import { studentMode } from '@/infra/compliance/studentClient';
import { collectAutoScreenFindings, runScreening } from '../complianceService';

// 학생 모델이 **실집행에 합류한 뒤** 지켜야 하는 것들 (8차 E-6).
//
// 그림자 모드의 불변식은 "호출자를 죽이지 않는다" 하나였다. 라이브의 불변식은 더 많다 —
// 이제 학생의 소견이 **리서처의 게시를 실제로 멈추기** 때문이다. 아래가 그 경계를 못 박는다:
//
//  ① 학생은 **거절시키지 못한다.** 소견이 몇 개든 심각도가 무엇이든 최대가 보류다.
//  ② 학생이 죽어도 **게시 흐름은 그대로다.** 보조 신호의 장애가 검수를 세우면 안 된다.
//  ③ 학생 소견은 **출처가 구별된다.** 오탐을 고치는 방법이 2차 AI와 다르기 때문.
//  ④ **모드가 꺼져 있으면 한 줄도 돌지 않는다.**

function input(over: Partial<ScreeningInput> = {}): ScreeningInput {
  return {
    title: '삼성전자 분석',
    summary: '요약',
    content: '공개 자료 기반 분석입니다.',
    assetClass: 'KR_EQUITY',
    assetName: '삼성전자',
    direction: 'UP',
    ...over,
  };
}

function studentFinding(): Finding {
  return {
    category: 'PRIVATE_INFO',
    severity: 'WARN',
    quote: '',
    // reason 에 확신 % 를 싣지 않는다 — 숫자는 confidence 로만 (Q8(b) · 2회차 A-1)
    reason: '미공개 중요정보 정황 (학생 모델)',
    source: 'student',
  };
}

function client(over: Partial<StudentClient> = {}): StudentClient {
  return {
    reviewerId: 'student:test@t0.5/L7',
    health: async (): Promise<StudentHealth> => ({
      ok: true,
      stub: false,
      tokenizerSha: 'abc123',
      trainedTokenizerSha: 'abc123',
      labels: [],
    }),
    usable: async () => true,
    consumeAvailabilityChange: () => null,
    screen: async (): Promise<StudentOutput> => ({
      findings: [studentFinding()],
      latencyMs: 9.1,
      tokenCount: 24,
      tokenIdsHead: [2, 15, 99, 4, 7],
    }),
    ...over,
  };
}

describe('studentMode — 어디까지 쓸 것인가', () => {
  it('사이드카 URL이 없으면 off — 모드 값과 무관하다', () => {
    expect(studentMode({} as unknown as NodeJS.ProcessEnv)).toBe('off');
    expect(studentMode({ STUDENT_MODE: 'live' } as unknown as NodeJS.ProcessEnv)).toBe('off');
  });

  it('URL이 있으면 기본이 live — 켜는 것이 기본이고 끄는 것이 선택이다', () => {
    expect(studentMode({ STUDENT_SIDECAR_URL: 'http://x' } as unknown as NodeJS.ProcessEnv)).toBe('live');
  });

  it('shadow·off는 명시적으로만 — 오타는 live로 떨어지지 않는다', () => {
    const env = (m: string) =>
      ({ STUDENT_SIDECAR_URL: 'http://x', STUDENT_MODE: m }) as unknown as NodeJS.ProcessEnv;
    expect(studentMode(env('shadow'))).toBe('shadow');
    expect(studentMode(env('off'))).toBe('off');
    // 알 수 없는 값은 live다. 반대로 두면 오타 하나로 검수가 조용히 약해진다 —
    // 꺼지는 쪽이 기본이면 그 사실이 아무 데도 드러나지 않기 때문
    expect(studentMode(env('LIVE'))).toBe('live');
  });
});

describe('학생 모델이 라이브로 합류했을 때', () => {
  it('소견이 1차 단계에 실려 게시를 보류시킨다', async () => {
    const r = await runScreening(input(), null, { student: client() });
    expect(r.findings.some((f) => f.source === 'student')).toBe(true);
    expect(r.action).toBe('HOLD');
    expect(r.needsOperatorReview).toBe(true);
  });

  it('**거절시키지 못한다** — 소견이 아무리 많아도 최대가 보류다', async () => {
    const many = client({
      screen: async () => ({
        findings: [
          studentFinding(),
          { ...studentFinding(), category: 'RUMOR' as const },
          { ...studentFinding(), category: 'PROFIT_GUARANTEE' as const },
        ],
        latencyMs: 9,
        tokenCount: 20,
        tokenIdsHead: [],
      }),
    });
    const r = await runScreening(input(), null, { student: many });
    expect(r.action).not.toBe('REJECT');
    expect(r.action).toBe('HOLD');
  });

  it('학생이 BLOCK 심각도를 보내와도 즉시 거절로 승격되지 않는다', async () => {
    // 사이드카는 WARN만 내지만, 그 계약이 깨지는 날 이 시험이 유일한 방어다.
    // 즉시 거절 권한은 **코드에 박힌 결정적 규칙**에만 있다 (resolveAction).
    const rogue = client({
      screen: async () => ({
        findings: [{ ...studentFinding(), severity: 'BLOCK' as const }],
        latencyMs: 9,
        tokenCount: 20,
        tokenIdsHead: [],
      }),
    });
    const r = await runScreening(input(), null, { student: rogue });
    expect(r.action).not.toBe('REJECT');
  });

  it('**라이브 학생이 죽으면 보류다** — 조용한 게시가 금지됐다 (Q0 · 2026-08-21 정책 전환)', async () => {
    // 이 시험은 예전에 정반대("죽어도 게시 흐름은 그대로다")를 단언했다.
    // 그 정책 아래에서 라이브 장애가 소견 0건 게시로 새고 있었고, 창업자가 뒤집었다.
    const dead = client({
      screen: async () => {
        throw new Error('사이드카 없음');
      },
    });
    const r = await runScreening(input(), null, { student: dead });
    expect(r.findings.some((f) => f.source === 'student')).toBe(false);
    expect(r.decision).toBe('UNAVAILABLE');
    expect(r.action).toBe('HOLD');
  });

  it('소견이 없으면 정상 리포트를 막지 않는다', async () => {
    const quiet = client({
      screen: async () => ({ findings: [], latencyMs: 8, tokenCount: 10, tokenIdsHead: [] }),
    });
    const r = await runScreening(input(), null, { student: quiet });
    expect(r.action).toBe('PUBLISH');
  });

  it('판정 주체에 학생이 남는다 — 무엇이 참여했는지 기록으로 알아야 한다', async () => {
    const r = await runScreening(input(), null, { student: client() });
    expect(r.reviewer).toContain('student:');
  });

  it('학생을 주지 않으면 한 줄도 돌지 않는다 (기본 상태)', async () => {
    const r = await runScreening(input(), null, {});
    expect(r.findings.some((f) => f.source === 'student')).toBe(false);
    expect(r.reviewer).toBe('rule');
  });
});

describe('collectAutoScreenFindings — 조립이 한 곳에만 있다', () => {
  it('code 와 all 을 나눠 돌려준다 — 즉시 거절 판단의 근거는 code 뿐이다', async () => {
    // 이 분리가 무너지면 학생 소견이 거절 판단에 섞인다. 게시 검수와 작성 중 사전 검사가
    // 같은 이 함수를 쓰므로, 여기서 지켜지면 두 곳 모두에서 지켜진다.
    const r = await collectAutoScreenFindings(input(), { student: client() });
    expect(r.all.some((f) => f.source === 'student')).toBe(true);
    expect(r.code.some((f) => f.source === 'student')).toBe(false);
  });

  it('학생이 없으면 code 와 all 이 같다', async () => {
    const r = await collectAutoScreenFindings(input(), {});
    expect(r.all).toEqual(r.code);
  });
});
