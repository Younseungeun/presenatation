import type { PrismaClient } from '@prisma/client';
import { buildTeacherPack } from './teacherPack';
import { getTeacherTag } from './appSettings';
import { getTeacherCorrections } from './teacherAnswerService';

// **판정을 내리는 순간 교사 질문지를 만들어 저장한다** (2026-08-27 창업자 지시).
//
// 목적: 운영자가 판정을 여러 건 쌓아 놓고, 나중에 질문지들을 일괄로 걷어 교사에게
// 물어본 뒤 재학습할지 정할 수 있게. 클릭(복사) 없이도 대기 목록에 쌓이려면 판정
// 시점에 만들어 박아 둬야 한다. 무작위 경계값이 매번 달라지므로, "그때 실제로 보낸
// 질문지"는 이 스냅샷으로만 남는다.

/**
 * 이 판정이 교사 질문지를 남길 케이스인가 (2026-08-27 창업자 지시).
 *
 *   반려·강제 철회         → 남긴다 (모델이 놓쳤거나 약하게 봤다 → 학습 표현·재학습)
 *   승인 + 지적 타당/오탐   → 남긴다 (심각도 조정 / 규칙 점검·재학습)
 *   승인 + 표시하지 않고 승인 → **안 남긴다** (논의할 것이 없다)
 *
 * ⚠ 검수 경로 기준이다. 신고 경로(이용자가 잡은 것)는 "승인 + 오탐"이 질문지 미작성인데
 * (모델이 아니라 사람이 잡은 것이라 모델이 배울 게 없다), 그 갈림은 신고 처리 쪽에서
 * verdict/findingsValid 를 어떻게 넣느냐로 표현한다 — 여기서는 검수 규칙만 안다.
 */
export function verdictNeedsTeacherPack(
  verdict: string | null,
  findingsValid: boolean | null,
): boolean {
  // TAKEDOWN·MISSED 는 둘 다 '검수가 놓친 위반'이다(screeningAccuracy.isMiss) — 미탐은
  // 재학습에서 가장 값진 라벨이라 반드시 질문지를 남긴다. MISSED 는 신고로 잡혔으나
  // 이미 닫혀 내리지 못한 건(abuseResolveService)이라, 처분만 다를 뿐 논의 대상은 같다
  if (verdict === 'REJECTED' || verdict === 'TAKEDOWN' || verdict === 'MISSED') return true;
  if (verdict === 'APPROVED') return findingsValid !== null; // 표시 안 함(null)만 제외
  if (verdict === 'KEPT') return findingsValid === true; // 판매 재개 + 지적 타당만
  return false;
}

/**
 * 리포트의 최신 검수 기록에 교사 질문지를 만들어 저장한다.
 *
 * **판정이 DB 에 쓰인 뒤에 부른다** — 사람 판정(verdict·categories·reason)이 질문지의
 * 절반이라, 그것이 아직 없으면 반쪽짜리가 저장된다. 그래서 트랜잭션 밖, 판정 커밋 후에
 * 최선-노력으로 부른다(실패해도 판정은 유효하고, 복사 시 다시 만들면 된다).
 *
 * 논의 불필요 케이스면 저장된 것을 **지운다** — 판정을 바꿔 재저장하는 경우
 * (지적 타당 → 표시 안 함) 낡은 질문지가 대기 목록에 남지 않게.
 */
export async function storeTeacherPackForReport(
  prisma: PrismaClient,
  reportId: string,
): Promise<void> {
  const review = await prisma.complianceReview.findFirst({
    where: { reportId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, operatorVerdict: true, aiFindingsValid: true },
  });
  if (!review) return;

  if (!verdictNeedsTeacherPack(review.operatorVerdict, review.aiFindingsValid)) {
    if (review.operatorVerdict) {
      await prisma.complianceReview
        .update({ where: { id: review.id }, data: { teacherPackText: null, teacherPackAt: null } })
        .catch(() => {});
    }
    return;
  }

  const teacher = await getTeacherTag(prisma);
  const corrections = await getTeacherCorrections(prisma).catch(() => []);
  const pack = await buildTeacherPack(prisma, review.id, {
    teacherTag: teacher.tag ?? '(미지정)',
    corrections,
  });
  if (!pack) return;

  await prisma.complianceReview
    .update({
      where: { id: review.id },
      data: { teacherPackText: pack.text, teacherPackAt: new Date() },
    })
    .catch((e) => {
      console.error('교사 질문지 저장 실패:', e);
    });
}
