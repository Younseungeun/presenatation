import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { ITEM_STUCK_MS, LIVENESS_STALE_MS, readHeartbeat } from '@/server/schedulerHealth';

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
 * 없고, 인증을 걸면 정작 모니터가 못 찌른다. 읽기 한 번뿐이라 계속 찔러도 부담이 없다.
 */
export async function GET() {
  const health = await readHeartbeat(prisma);
  // **두 가지가 따로 고장 난다.** 프로세스가 멈추는 것(stale)과 한 배치가 안 끝나는
  // 것(stuck)은 원인도 처방도 다르므로, 503 하나로 뭉뚱그리지 않고 어느 쪽인지 적는다 —
  // 모니터 알림을 받은 사람이 로그를 뒤지기 전에 무엇을 볼지 알 수 있어야 한다
  const reason = health.stale ? 'SCHEDULER_DOWN' : health.stuck ? 'BATCH_STUCK' : null;
  return NextResponse.json(
    {
      ok: reason === null,
      reason,
      lastBeatAt: health.lastBeatAt?.toISOString() ?? null,
      ageSeconds: health.ageMs === null ? null : Math.floor(health.ageMs / 1000),
      staleAfterSeconds: LIVENESS_STALE_MS / 1000,
      running: health.running,
      runningForSeconds:
        health.runningForMs === null ? null : Math.floor(health.runningForMs / 1000),
      stuckAfterSeconds: ITEM_STUCK_MS / 1000,
    },
    {
      // 멈춘 상태를 200으로 답하면 모니터가 아무것도 못 한다
      status: reason === null ? 200 : 503,
      // **캐시되면 이 엔드포인트는 거짓말하는 장치가 된다.** force-dynamic은 우리
      // 프레임워크까지만 막는다 — 앞에 CDN·리버스 프록시가 서면 200 한 장을 붙들고
      // 스케줄러가 죽은 뒤에도 계속 "ok"를 돌려준다. 감시자가 감시받는 대상보다
      // 조용히 고장 나는 경로라 헤더로 못을 박는다
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  );
}
