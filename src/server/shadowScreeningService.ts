import type { PrismaClient } from '@prisma/client';
import type { ScreeningInput } from '@/domain/compliance';
import type { StudentClient } from '@/infra/compliance/studentClient';

// 그림자 모드 — 학생이 판단하되 **아무것도 처리하지 않는** 경로.
//
// **이 파일의 유일한 책임은 "실집행에 영향을 주지 않는 것"이다.**
// 그래서 규칙이 셋이고, 셋 다 어기기 쉬운 방향으로 어긋난다:
//
// ① **호출자의 트랜잭션에 끼지 않는다.** 게시 트랜잭션에 넣으면 그림자 기록 실패가
//    게시 실패가 된다. 권한 없는 판정이 게시를 죽이는 것은 정의상 모순이다.
// ② **모든 예외를 삼킨다.** 사이드카 장애·DB 오류 무엇이든 호출자는 모른다.
//    그림자 기록의 결측은 사건이 아니라 결측이다.
// ③ **지문이 다르면 소견을 버린다.** 학습과 서빙의 토크나이저가 다르면 예외가 아니라
//    조용히 틀린 답이 나오므로, 틀린 답을 기록해 나중에 일치율을 오염시키느니 비운다.

/** 지문 불일치를 매 건 로그로 쏟지 않기 위한 1회 경고 (같은 프로세스 안에서) */
let fingerprintWarned = false;

/**
 * 학생 판정을 ShadowComplianceReview에 기록한다. **어떤 경우에도 던지지 않는다.**
 *
 * 호출자는 결과를 기다릴 필요가 없다 — 반환값을 무시해도 되고, await 하지 않아도 된다.
 * 다만 테스트에서 확인할 수 있도록 무엇을 했는지는 돌려준다.
 */
export async function recordShadowJudgment(
  prisma: PrismaClient,
  complianceReviewId: string,
  input: ScreeningInput,
  client: StudentClient | null,
  now = new Date(),
): Promise<'recorded' | 'skipped' | 'failed'> {
  if (!client) return 'skipped'; // 공급자 없음 — 기능이 완전히 꺼진 상태
  try {
    const health = await client.health();
    if (!health?.ok) return 'skipped';

    // 스텁 모드(가중치 없이 토크나이저만)는 소견을 낼 수 없다. 그래도 기록은 남긴다 —
    // 배관이 실제로 돌았다는 증거가 되고, 지연(latencyMs)은 그 자체로 측정값이다.
    if (
      health.trainedTokenizerSha &&
      health.trainedTokenizerSha !== health.tokenizerSha
    ) {
      if (!fingerprintWarned) {
        fingerprintWarned = true;
        console.error(
          '학생 모델 토크나이저 지문 불일치 — 소견을 쓰지 않습니다. ' +
            `학습 ${health.trainedTokenizerSha} ≠ 서빙 ${health.tokenizerSha}. ` +
            'local_models/ 의 파일이 학습 때와 다릅니다.',
        );
      }
      return 'skipped';
    }

    const out = await client.screen(input);
    if (!out) return 'failed';

    await prisma.shadowComplianceReview.create({
      data: {
        complianceReviewId,
        // **가중치 지문을 표식에 덧붙인다** (관리자 앱 3회차 B-1 발견).
        // reviewerId 는 설정(태그·임계값)에서 조립되어, 재학습으로 가중치만 갈리면
        // 같은 표식이 된다 — 그러면 서로 다른 모델의 그림자 기록이 한 판정기의
        // 기록으로 합쳐져 채택 판단이 오염된다. health 를 이미 불렀으므로 공짜다
        reviewer: `${client.reviewerId}#${health.modelSha?.slice(0, 8) ?? 'nosha'}`,
        findingsJson: JSON.stringify(out.findings),
        latencyMs: Math.round(out.latencyMs),
        createdAt: now,
      },
    });
    return 'recorded';
  } catch (e) {
    // 여기서 던지면 게시가 죽는다. 그림자는 그럴 자격이 없다
    console.error('그림자 판정 기록 실패:', (e as Error).message);
    return 'failed';
  }
}

/**
 * 실집행 판정과 학생 판정의 일치율 — 졸업 조건의 원천.
 *
 * **보류 큐의 편향을 여기서 고치지 않는다.** 이 집계가 보는 것은 검수 기록이 있는 건
 * 전부이고, 통과 건의 정답 라벨은 별도 무작위 감사(audit:batch)가 공급한다.
 * 그 감사가 없으면 이 수치는 "학생이 교사를 얼마나 흉내내는가"까지만 말한다.
 */
export async function getShadowAgreement(prisma: PrismaClient, limit = 1_000) {
  const rows = await prisma.shadowComplianceReview.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      reviewer: true,
      findingsJson: true,
      latencyMs: true,
      complianceReview: { select: { findingsJson: true, decision: true } },
    },
  });
  if (rows.length === 0) return null;

  const categories = (json: string): Set<string> => {
    try {
      const list = JSON.parse(json) as { category?: string }[];
      return new Set(list.flatMap((f) => (f.category ? [f.category] : [])));
    } catch {
      return new Set(); // 구버전 기록은 형식이 다를 수 있다 — 파싱은 항상 방어적으로
    }
  };

  let bothFlagged = 0;
  let bothClear = 0;
  let studentOnly = 0;
  let actingOnly = 0;
  const latencies: number[] = [];

  for (const r of rows) {
    const s = categories(r.findingsJson);
    const a = categories(r.complianceReview.findingsJson);
    if (s.size > 0 && a.size > 0) bothFlagged += 1;
    else if (s.size === 0 && a.size === 0) bothClear += 1;
    else if (s.size > 0) studentOnly += 1;
    else actingOnly += 1;
    if (r.latencyMs != null) latencies.push(r.latencyMs);
  }

  const sorted = latencies.sort((x, y) => x - y);
  const p = (q: number) => (sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null);

  return {
    total: rows.length,
    reviewers: [...new Set(rows.map((r) => r.reviewer))],
    agreement: (bothFlagged + bothClear) / rows.length,
    bothFlagged,
    bothClear,
    /** 학생만 잡은 건 — 규칙이 놓친 것을 메웠거나, 학생의 오탐이거나. 사람이 봐야 갈린다 */
    studentOnly,
    /** 실집행만 잡은 건 — 학생의 미탐 */
    actingOnly,
    latencyP50: p(0.5),
    latencyP99: p(0.99),
  };
}
