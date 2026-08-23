import type { PrismaClient } from '@prisma/client';
import type { Finding } from '@/domain/compliance';

// **재학습 트리거 계기판** (20차 X-4 · 21차 Y-5(a) 검토 확정).
//
// 재는 것은 하나다 — **학생 예측과 운영자 최종 판정이 엇갈린 건수.** 50건이 쌓이면
// 재학습할 때다. 다른 게이지(미탐 20건 등 19차까지의 후보)는 근거가 없어 죽었고,
// 정탐 앵커·정상 표본은 문턱 없는 참고 숫자다 (관리자 앱 2회차 B-5 답).
//
// ── 엇갈림의 정의 (21차 Y-5(a)) ──────────────────────────────────────
// **위반 여부의 엇갈림만 센다** — 학생 WARN + 운영자 승인(오탐 방향), 학생 침묵 +
// 운영자 반려(미탐 방향). 세부 유형이 다른 것(학생은 수익보장, 운영자는 풍문)은
// 엇갈림이 아니다 — 위반이라는 판단 자체는 맞았다.
//
// ── X-6 비노출과의 거리 ─────────────────────────────────────────────
// 이 함수는 **숫자 하나**만 돌려준다. 엇갈린 건의 목록 조회는 만들지 않는다(21차 지시:
// 클릭해서 목록을 보는 순간 운영자의 독립 라벨링이 오염된다). 목록이 필요한 것은
// 학습 내보내기(train:operator)뿐이고 그건 운영자 화면이 아니다.

/** @근거 설계 — 20차 X-4 검토 확정값: 엇갈린 하드 네거티브 50건 = 재학습 신호 */
export const HARD_NEGATIVE_RETRAIN_THRESHOLD = 50;

const ADOPTED_AT_KEY = 'screening.student.retrain.adoptedAt';

/** 재학습 채택 시점 기록 — 카운터의 리셋은 채택만 만든다 */
export async function markRetrainAdopted(prisma: PrismaClient, now = new Date()): Promise<void> {
  await prisma.appSetting.upsert({
    where: { key: ADOPTED_AT_KEY },
    create: { key: ADOPTED_AT_KEY, value: now.toISOString() },
    update: { value: now.toISOString() },
  });
}

export async function getRetrainAdoptedAt(prisma: PrismaClient): Promise<Date | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: ADOPTED_AT_KEY } });
  if (!row) return null;
  const d = new Date(row.value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function parseFindings(json: string): Finding[] {
  try {
    return JSON.parse(json) as Finding[];
  } catch {
    return [];
  }
}

/**
 * 하드 네거티브 카운트 — 마지막 재학습 채택 이후, 학생과 운영자의 위반 판단이
 * 엇갈린 검수 건수.
 *
 * 학생의 판단을 읽는 곳이 둘이다: 그림자 모드면 그림자 표, 라이브면 본 기록의
 * source='student' 소견. **학생이 결석한 건은 세지 않는다** — studentAbsence 가 찍힌
 * 건(장애·우회)과 학생 참여 흔적이 아예 없는 건은 "학생이 틀렸다"의 표본이 아니다
 * (21차 gap 17형 함정: 결석을 미탐으로 세면 지표가 오염된다).
 */
export interface HardNegativeMismatch {
  reviewId: string;
  reportId: string;
  /** STUDENT_FP = 학생 WARN + 운영자 승인 / STUDENT_MISS = 학생 침묵 + 운영자 반려 */
  direction: 'STUDENT_FP' | 'STUDENT_MISS';
  createdAt: Date;
}

async function collectMismatches(prisma: PrismaClient): Promise<{
  since: Date | null;
  mismatches: HardNegativeMismatch[];
}> {
  const since = await getRetrainAdoptedAt(prisma);
  const reviews = await prisma.complianceReview.findMany({
    where: {
      operatorVerdict: { not: null },
      studentAbsence: null,
      ...(since ? { createdAt: { gt: since } } : {}),
    },
    select: {
      id: true,
      reportId: true,
      reviewer: true,
      findingsJson: true,
      operatorVerdict: true,
      createdAt: true,
      shadowReviews: {
        select: { findingsJson: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });

  const mismatches: HardNegativeMismatch[] = [];
  for (const r of reviews) {
    // 학생의 위반 판단 — 그림자가 있으면 그림자, 없으면 라이브 소견에서 읽는다
    let studentViolation: boolean | null = null;
    if (r.shadowReviews.length > 0) {
      studentViolation = parseFindings(r.shadowReviews[0].findingsJson).length > 0;
    } else if (r.reviewer.includes('student:')) {
      studentViolation = parseFindings(r.findingsJson).some((f) => f.source === 'student');
    }
    if (studentViolation === null) continue; // 학생이 참여하지 않은 건 — 표본이 아니다

    const operatorViolation =
      r.operatorVerdict === 'REJECTED' || r.operatorVerdict === 'TAKEDOWN';
    if (studentViolation !== operatorViolation) {
      mismatches.push({
        reviewId: r.id,
        reportId: r.reportId,
        direction: studentViolation ? 'STUDENT_FP' : 'STUDENT_MISS',
        createdAt: r.createdAt,
      });
    }
  }
  return { since, mismatches };
}

export async function countHardNegatives(prisma: PrismaClient) {
  const { since, mismatches } = await collectMismatches(prisma);
  return {
    count: mismatches.length,
    threshold: HARD_NEGATIVE_RETRAIN_THRESHOLD,
    reached: mismatches.length >= HARD_NEGATIVE_RETRAIN_THRESHOLD,
    sinceAdoptedAt: since,
  };
}

/**
 * 진위 판단 표본 (22차 Y-5(a) 검토 확정) — 50건 도달이 곧 재학습이 아니다.
 *
 * "엇갈림"은 **학생이 틀렸다**와 **운영자가 실수했는데 학생이 맞았다**에서 같은 값을
 * 올린다(gap 17형). 운영자 실수를 그대로 학습시키면 학생이 실수를 배우므로, 50건이
 * 차면 **운영자가 아닌 제3자(창업자)**가 이 표본으로 진위를 가린 뒤에 재학습으로
 * 넘긴다 — 그 판단이 끝난 뒤에야 markRetrainAdopted 를 부른다.
 *
 * ⚠ 운영자 화면에 싣지 말 것 (X-6): 이 목록은 운영자 자신의 판정을 재심하는 재료라,
 * 판정 당사자가 보면 다음 판정이 목록을 의식한다. CLI 나 창업자 전용 자리에서만.
 */
export async function sampleHardNegatives(prisma: PrismaClient, take = 10) {
  const { mismatches } = await collectMismatches(prisma);
  // 최신순 표본 — 무작위보다 재현 가능하고, 최근 건일수록 현재 모델의 성질을 말한다
  return [...mismatches]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, take);
}
