import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { STUDENT_LABELS } from '@/domain/studentText';
import { graduatePhrase } from '@/server/phraseGraduationService';
import { requireOperatorId, toErrorResponse } from '../../../_lib/http';

/**
 * 사전 항목 졸업 — 항목을 끄고 대비쌍을 **영구 회귀 시험셋**에 넣는다.
 *
 * 사전에서 나가는 **유일한 문**이다(승격은 20차 X-2 로 금지됐다). 이 라우트가 없어
 * 지금까지 아무도 졸업시킬 수 없었고, 그동안 사전은 늘기만 했다 — 그 끝에
 * `PHONETIC_PHRASE_CAP`(200)과 밀어내기가 있고, 밀어내기 경보는 *"졸업시켜 자리를
 * 비우십시오"* 라고 말하는데 비울 방법이 화면에 없었다.
 *
 * **검증은 서비스가 한다.** 여기서 다시 재지 않는다 — 화면의 실시간 경고와 서비스의
 * 관문이 각자 판단하면 언젠가 갈라지고, 그때 "화면은 된다는데 눌리지 않는" 자리가 생긴다.
 * 화면 쪽 자카드 계산은 순전히 미리 알려 주기 위한 것이고 최종 관문은 `graduatePhrase` 다.
 */

const bodySchema = z.object({
  phraseId: z.string().min(1),
  cases: z
    .array(
      z.object({
        text: z.string().min(1).max(400),
        expectViolation: z.boolean(),
        // 위반 쪽만 필요하고, **학생 라벨 공간 안**이어야 한다 — 학생이 낼 수 없는
        // 유형을 기대하면 그 문항은 영원히 빨간불이라 재학습이 영영 채택되지 않는다
        category: z.enum(STUDENT_LABELS).optional(),
      }),
    )
    .min(1)
    .max(40),
});

export async function POST(req: NextRequest) {
  try {
    const operatorUserId = await requireOperatorId(prisma);
    const body = bodySchema.parse(await req.json());
    const { registered } = await graduatePhrase(prisma, { ...body, operatorUserId });
    return NextResponse.json({ ok: true, registered });
  } catch (e) {
    // GraduationError 매핑은 toErrorResponse 안에 있다 — 격리 라우트와 **같은 계약**을
    // 써야 하고, 두 곳에서 각자 매핑하면 언젠가 한쪽만 code 를 빠뜨린다
    return toErrorResponse(e);
  }
}
