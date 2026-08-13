import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { HEARTBEAT_STALE_MS, readHeartbeat } from '@/server/schedulerHealth';

export const dynamic = 'force-dynamic';

/**
 * 스케줄러 생사 — **밖에서 찔러 보라고 열어 둔 문.**
 *
 * 스케줄러가 멈춘 것을 스케줄러가 알릴 수는 없다. 그래서 자기 심박은 스스로 쓰고,
 * 낡았는지 판단하는 일은 **다른 프로세스**(웹)가 맡는다. 그마저도 누군가 물어봐야
 * 답하므로, 운영에서는 외부 업타임 모니터(UptimeRobot 등)가 이 주소를 주기적으로
 * 찌르게 두는 것이 완성이다 — 503이면 알림이 온다.
 *
 * 인증을 걸지 않는다: 여기서 나가는 것은 "심박이 몇 초 전인가"뿐이라 노출 위험이
 * 없고, 인증을 걸면 정작 모니터가 못 찌른다.
 */
export async function GET() {
  const health = await readHeartbeat(prisma);
  return NextResponse.json(
    {
      ok: !health.stale,
      lastBeatAt: health.lastBeatAt?.toISOString() ?? null,
      ageSeconds: health.ageMs === null ? null : Math.floor(health.ageMs / 1000),
      staleAfterSeconds: HEARTBEAT_STALE_MS / 1000,
    },
    // 멈춘 상태를 200으로 답하면 모니터가 아무것도 못 한다
    { status: health.stale ? 503 : 200 },
  );
}
