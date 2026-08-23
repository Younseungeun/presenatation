import type { PrismaClient } from '@prisma/client';
import { ASSET_CLASS_LABEL, ASSET_CLASSES } from '@/domain/constants';
import { getPauseState } from '@/server/judgmentPause';
import { readHeartbeat } from '@/server/schedulerHealth';
import { runCanaryChecks } from '@/server/screeningCanaryRunner';

// 상태 띠지 — 홈 맨 위를 흐르는 한 줄 (시안 v3 `.band`).
//
// **왜 홈에 있나**: 아래 타일 넷은 "사람을 기다리는 일"을 세지만, 이 줄은
// **기계가 살아 있는가**를 말한다. 둘은 성격이 달라 섞으면 안 된다 — 판정이
// 멈춰 있으면 타일의 건수는 오늘도 0일 수 있고, 그 0은 "일이 없다"가 아니라
// "재고 있지 않다"는 뜻이다.
//
// **색은 방향이 있는 곳에만 준다** (이용자 앱 시장 띠지의 규칙과 같다).
// 다만 자리가 다르다: 시장 띠지는 값에 방향이 없어(137장은 규모일 뿐) 증감에만
// 색을 줬는데, 여기는 **값 자체가 방향**이다 — 정상은 무채색, 정지는 붉다.
//
// 스케줄러·알림 채널은 **켜져 있어도 초록**이다. 이 둘은 감시하는 장치 자체라
// 살아 있다는 사실이 배경이 아니라 확인해야 할 정보다 — 꺼져 있으면 경보 자체가
// 안 오고, 그러면 조용한 것과 사고가 없는 것이 구별되지 않는다.

export interface StatusTick {
  label: string;
  value: string;
  /** 'on' = 살아 있다(초록) · 'off' = 멈췄다(빨강) · 없음 = 정상이라 색이 필요 없다 */
  tone?: 'on' | 'off';
}

export async function getStatusBand(prisma: PrismaClient): Promise<StatusTick[]> {
  const [pause, beat] = await Promise.all([getPauseState(prisma), readHeartbeat(prisma)]);

  const ticks: StatusTick[] = ASSET_CLASSES.map((c) => {
    const paused = pause.global || (pause.byAssetClass[c] ?? false);
    return {
      label: `${ASSET_CLASS_LABEL[c]} 판정`,
      value: paused ? '정지' : '정상',
      ...(paused ? { tone: 'off' as const } : {}),
    };
  });

  // 살아 있음 = 심박이 최근이고(stale 아님) 한 항목에 갇혀 있지도 않다.
  // 프로세스가 떠 있는 것과 일이 되는 것은 다르다 — 둘 다 봐야 한다
  const schedulerOk = !beat.stale && !beat.stuck;
  ticks.push({
    label: '스케줄러',
    value: beat.stale ? 'OFF' : beat.stuck ? '멈춤' : 'ON',
    tone: schedulerOk ? 'on' : 'off',
  });

  // **검수 규칙이 살아 있는가** (2026-08-21 사용자 지시).
  //
  // 스케줄러 칸과 다른 고장이다: 배치는 도는데 규칙 한 층이 죽어 있을 수 있고,
  // 그러면 그 층이 통과시키는 리포트를 **아무도 막지 않는 채로 하루가 간다.**
  // 2026-08-20에 실제로 그랬다 — 표기 회피 탐지가 꺼진 채 돌았는데 예외도 경고도
  // 없었고 시험 820건이 전부 초록이었다.
  //
  // **박동을 읽지 않고 직접 잰다.** 박동은 성공했을 때만 찍히므로, 실패한 상태는
  // 24시간이 지나야 낡음으로 드러난다 — 띠지가 하루 늦게 빨개지면 띠지가 아니다.
  // 비용은 정규식 6번(AI 호출 0, 종목명은 프로세스 캐시).
  const canary = await runCanaryChecks(prisma).catch(() => null);
  ticks.push({
    label: '검수 규칙',
    value: !canary ? '확인 불가' : canary.failures.length === 0 ? '정상' : `${canary.failures.length}층 실패`,
    tone: canary && canary.failures.length === 0 ? 'on' : 'off',
  });

  // 알림이 나갈 길이 하나라도 살아 있는가. 인앱은 항상 되므로 여기서 재는 것은
  // **앱 밖으로 닿는 길**이다 — 그게 죽으면 급한 소식이 앱을 연 사람에게만 간다
  const pushSubs = await prisma.pushSubscription.count();
  ticks.push({
    label: '푸시 구독',
    value: pushSubs > 0 ? `${pushSubs}대` : '없음',
    tone: pushSubs > 0 ? 'on' : 'off',
  });

  return ticks;
}
