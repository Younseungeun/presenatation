import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/server/db';
import { hitRateLimit } from '@/server/rateLimit';
import { issueRecoveryGrant } from '@/server/recoveryGrant';
import { redeemRecoveryToken } from '@/server/recoveryService';
import { RecoveryError } from '@/server/recoveryToken';

// 비상 복구 창구 (2026-08-17 검토 7차 Q1) — **로그인 없이 열리는 유일한 문이다.**
//
// 여기가 로그인 밖에 있는 이유는 단순하다: 이 경로가 필요한 상황이란 **로그인 자체가
// 불가능한 상황**이다(본인 인증 공급자 다운 + 기기 분실). 세션을 요구하면 그 순간
// 이 문은 있으나 마나 하다.
//
// 대신 문 자체를 좁힌다:
//   · 설정이 없으면 **404** — 안 쓰는 서버에는 이 문이 존재하지도 않는다
//   · 통과해도 열리는 것은 **패스키 등록 하나**뿐이다(세션이 아니다)
//   · 표는 1회용이고, 대상은 창업자 계정 하나뿐이다
//   · 호출 제한을 건다 — 서명 위조를 무차별로 두드리는 것은 무의미하지만(Ed25519),
//     이 문에 부하를 거는 것 자체를 값싸게 두지 않는다

const bodySchema = z.object({
  token: z.string().min(1).max(2000),
  /** 왜 금고를 열었나 — 감사 기록에 그대로 남는다 */
  note: z.string().max(300).optional(),
});

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    req.headers.get('x-real-ip') ||
    'unknown';
  if (!hitRateLimit('recovery:ip', ip, { limit: 5, windowMs: 60_000 }).ok) {
    return NextResponse.json({ error: '잠시 후 다시 시도해주세요' }, { status: 429 });
  }

  try {
    const body = bodySchema.parse(await req.json());
    const { userId } = await redeemRecoveryToken(prisma, body);
    await issueRecoveryGrant(userId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      return NextResponse.json({ error: '입력 형식 오류' }, { status: 400 });
    }
    if (e instanceof RecoveryError) {
      // 설정이 없는 서버에서는 **없는 경로처럼** 답한다 — 있다는 사실 자체를 안 알린다
      if (e.code === 'DISABLED') {
        return NextResponse.json({ error: '찾을 수 없습니다' }, { status: 404 });
      }
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    return NextResponse.json({ error: '복구에 실패했습니다' }, { status: 400 });
  }
}
