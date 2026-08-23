import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { ScreeningInput } from '@/domain/compliance';
import type { StudentClient, StudentHealth, StudentOutput } from '@/infra/compliance/studentClient';
import { recordShadowJudgment } from '../shadowScreeningService';

// 그림자 모드의 불변식은 하나다: **어떤 경우에도 호출자를 죽이지 않는다.**
// 학생은 아직 아무것도 처리하지 않으므로, 학생 쪽 실패가 게시를 막으면 그건
// "권한 없는 판정이 게시를 죽인" 것이라 정의상 모순이다. 아래가 그걸 못 박는다.

function input(): ScreeningInput {
  return {
    title: '삼성전자 분석',
    summary: '요약',
    content: '공개 자료 기반 분석입니다.',
    assetClass: 'KR_EQUITY',
    assetName: '삼성전자',
    direction: 'UP',
  };
}

function client(over: Partial<StudentClient> = {}): StudentClient {
  return {
    reviewerId: 'student:test@t0.5',
    health: async (): Promise<StudentHealth> => ({
      ok: true,
      stub: false,
      tokenizerSha: 'abc123',
      trainedTokenizerSha: 'abc123',
      modelSha: 'cafe0123deadbeef',
      labels: [],
    }),
    usable: async () => true,
    consumeAvailabilityChange: () => null,
    screen: async (): Promise<StudentOutput> => ({
      findings: [],
      latencyMs: 4.2,
      tokenCount: 12,
      tokenIdsHead: [2, 15, 99, 4, 7],
    }),
    ...over,
  };
}

/** create만 쓰므로 그 한 조각만 흉내낸다 */
function db(create = vi.fn().mockResolvedValue({})) {
  return {
    prisma: { shadowComplianceReview: { create } } as unknown as PrismaClient,
    create,
  };
}

describe('recordShadowJudgment — 정상 경로', () => {
  it('학생 판정을 기록한다', async () => {
    const { prisma, create } = db();
    const r = await recordShadowJudgment(prisma, 'review-1', input(), client());
    expect(r).toBe('recorded');
    expect(create).toHaveBeenCalledOnce();
    const data = create.mock.calls[0][0].data;
    expect(data.complianceReviewId).toBe('review-1');
    // 가중치 지문이 접미로 붙는다 (3회차 B-1) — 같은 태그의 다른 가중치가 한 판정기로 합산되면 안 된다
    expect(data.reviewer).toBe('student:test@t0.5#cafe0123');
    // 지연은 졸업 조건 ③(p99·이상점)의 원천이라 반드시 남아야 한다
    expect(data.latencyMs).toBe(4);
  });

  it('공급자가 없으면 아무것도 하지 않는다 — 기능이 완전히 꺼진 상태', async () => {
    const { prisma, create } = db();
    expect(await recordShadowJudgment(prisma, 'review-1', input(), null)).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });
});

describe('recordShadowJudgment — 실패해도 던지지 않는다', () => {
  it('사이드카가 죽어 있어도(health null) 던지지 않는다', async () => {
    const { prisma, create } = db();
    const r = await recordShadowJudgment(
      prisma,
      'review-1',
      input(),
      client({ health: async () => null }),
    );
    expect(r).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('추론이 실패해도(screen null) 던지지 않는다', async () => {
    const { prisma } = db();
    expect(
      await recordShadowJudgment(prisma, 'review-1', input(), client({ screen: async () => null })),
    ).toBe('failed');
  });

  it('사이드카가 예외를 던져도 삼킨다', async () => {
    const { prisma } = db();
    const boom = client({
      screen: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(await recordShadowJudgment(prisma, 'review-1', input(), boom)).toBe('failed');
  });

  it('**DB 쓰기가 실패해도 삼킨다** — 그림자 기록 때문에 게시가 죽으면 안 된다', async () => {
    const { prisma } = db(vi.fn().mockRejectedValue(new Error('database is locked')));
    expect(await recordShadowJudgment(prisma, 'review-1', input(), client())).toBe('failed');
  });
});

describe('recordShadowJudgment — 토크나이저 지문', () => {
  it('지문이 다르면 소견을 쓰지 않는다 — 틀린 답을 기록하면 일치율이 오염된다', async () => {
    const { prisma, create } = db();
    const mismatched = client({
      health: async () => ({
        ok: true,
        stub: false,
        tokenizerSha: 'serving-xyz',
        trainedTokenizerSha: 'trained-abc',
        labels: [],
      }),
    });
    expect(await recordShadowJudgment(prisma, 'review-1', input(), mismatched)).toBe('skipped');
    expect(create).not.toHaveBeenCalled();
  });

  it('스텁 모드(학습 지문 없음)는 기록한다 — 배관이 돌았다는 증거이고 지연은 측정값이다', async () => {
    const { prisma, create } = db();
    const stub = client({
      health: async () => ({
        ok: true,
        stub: true,
        tokenizerSha: 'serving-xyz',
        trainedTokenizerSha: undefined,
        labels: [],
      }),
    });
    expect(await recordShadowJudgment(prisma, 'review-1', input(), stub)).toBe('recorded');
    expect(create).toHaveBeenCalledOnce();
  });
});
