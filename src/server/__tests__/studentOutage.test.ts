import { describe, expect, it } from 'vitest';
import { runScreening } from '../complianceService';
import type { StudentClient } from '@/infra/compliance/studentClient';
import type { ScreeningInput } from '@/domain/compliance';

// **검사기가 죽으면 게시를 보류한다** (Q0 · 2026-08-21 창업자 확정).
//
// 재던 구멍 그대로: STUDENT_MODE=live 인데 사이드카가 죽으면 —
//   resolveLiveStudent → undefined → 학생 소견 0건 → decide([]) = PASS → **그냥 게시**
// 즉 검수가 가장 약한 순간에 모든 리포트가 규칙 단독으로 조용히 나갔다.

const input: ScreeningInput = {
  title: '',
  summary: '',
  content: '공개 자료 기반 분석입니다.',
  assetClass: 'KR_EQUITY',
  assetName: '삼성전자',
  direction: 'UP',
  targetType: 'RETURN_PCT',
  magnitudePct: 12,
  horizonDays: 90,
  confidence: 5,
};

const violating: ScreeningInput = { ...input, content: '이 종목은 원금을 보장해 드리겠습니다.' };

/** 부르면 죽는 학생 — 라이브 도중 장애를 흉내 낸다 */
const dyingStudent: StudentClient = {
  reviewerId: 'student:test@t0.5',
  health: async () => null,
  screen: async () => null,
  usable: async () => false,
  consumeAvailabilityChange: () => null,
};

describe('학생 장애 → 보류 (Q0)', () => {
  it('outage 플래그면 소견 0건이어도 UNAVAILABLE 보류다 — 조용한 게시가 금지의 핵심', async () => {
    const r = await runScreening(input, null, { studentOutage: true });
    expect(r.decision).toBe('UNAVAILABLE');
    expect(r.action).toBe('HOLD');
    expect(r.needsOperatorReview).toBe(true);
    // 어느 검사기였는지가 reviewer 에 남는다 — 화면·집계가 이 조각으로 가른다
    expect(r.reviewer).toContain('(장애)');
  });

  it('라이브 학생이 호출 중에 죽어도 같다 (studentFailed 경로)', async () => {
    const r = await runScreening(input, null, { student: dyingStudent });
    expect(r.decision).toBe('UNAVAILABLE');
    expect(r.action).toBe('HOLD');
  });

  it('**규칙 BLOCK 이 장애보다 세다** — 거절할 것을 보류로 낮추지 않는다', async () => {
    const r = await runScreening(violating, null, { studentOutage: true });
    expect(r.action).toBe('REJECT');
  });

  it('장애가 아니면(의도된 끔) 규칙 단독 게시가 그대로다 — shadow·off 는 설계다', async () => {
    const r = await runScreening(input, null, {});
    expect(r.decision).toBe('PASS');
    expect(r.action).toBe('PUBLISH');
  });
});
