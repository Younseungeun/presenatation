import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { normalizeBio, validateBio } from '@/domain/researcherBio';
import { prisma } from '@/server/db';
import { requireUserId, toErrorResponse } from '../../_lib/http';

// 내 프로필 수정 — 필명(모든 계정) + 소개말(리서처만).
// 둘 다 팔로우 목록·리더보드에 나가는 공개 정보라 본인만 고칠 수 있다.
// (이름·휴대폰 같은 본인 인증 정보는 CI에 묶여 있어 여기서 바꿀 수 없다)
//
// 소개말은 자유 서술이라 수익률 약속·외부 연락처를 막는다 (domain/researcherBio.ts).
// 리서처가 아닌 계정이 소개말을 보내면 조용히 무시하는 대신 400 — 팔로우당하지 않는
// 계정에는 PR 자리가 없어서, 저장된 줄 알고 넘어가면 그게 더 나쁜 거짓말이다.

const bodySchema = z.object({
  penName: z.string().max(30, '필명은 30자까지 쓸 수 있습니다').nullable(),
  bio: z.string().nullable().optional(),
});

export async function PATCH(req: NextRequest) {
  try {
    const userId = await requireUserId();
    const { penName, bio } = bodySchema.parse(await req.json());

    const updated = await prisma.user.update({
      where: { id: userId },
      data: { penName: penName?.trim() || null },
      select: { penName: true, researcherProfile: { select: { id: true } } },
    });

    if (bio !== undefined) {
      const profileId = updated.researcherProfile?.id;
      if (!profileId) {
        return NextResponse.json(
          { error: '소개말은 리서처 계정에만 있습니다' },
          { status: 400 },
        );
      }
      const normalized = normalizeBio(bio);
      const violation = validateBio(normalized);
      if (violation) {
        return NextResponse.json({ error: violation.reason }, { status: 400 });
      }
      await prisma.researcherProfile.update({
        where: { id: profileId },
        data: { bio: normalized },
      });
    }

    return NextResponse.json({ penName: updated.penName });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: e.issues[0]?.message ?? '입력 형식 오류' }, { status: 400 });
    }
    return toErrorResponse(e);
  }
}
