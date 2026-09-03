import type { PrismaClient } from '@prisma/client';
import { ASSET_CLASS_LABEL, ASSET_CLASSES } from '@/domain/constants';
import { getPauseState } from '@/server/judgmentPause';
import { readHeartbeat } from '@/server/schedulerHealth';
import { runCanaryChecks } from '@/server/screeningCanaryRunner';
import { readAttendanceBeat } from '@/server/studentAttendance';
import { readSourceHealth } from '@/server/sourceHealthService';

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
  /**
   * 'on' = 살아 있다(초록) · 'off' = 멈췄다(빨강) · 'idle' = 확인 불가(회색, 비활성) ·
   * 없음 = 정상이라 색이 필요 없다.
   * idle은 "고장"이 아니라 "지금은 잴 수 없다"다 — 스케줄러가 꺼져 있으면 검수 상태를
   * 제대로 확인할 수 없어 정상/비정상 대신 이걸 쓴다(빨강이면 없는 사고를 쫓게 된다).
   */
  tone?: 'on' | 'off' | 'idle';
}

export async function getStatusBand(prisma: PrismaClient): Promise<StatusTick[]> {
  const [pause, beat, attendance, sourceHealth] = await Promise.all([
    getPauseState(prisma),
    readHeartbeat(prisma),
    readAttendanceBeat(prisma),
    readSourceHealth(prisma),
  ]);

  // 판정 칸에 **시세 소스 헬스를 접는다** (2026-08-29 사용자 지시). 축은 둘이다 —
  // 판정 정지(되돌리기·교차검증·운영자 정지)와 시세 소스(살아 있나). 한 칸에서 나쁜
  // 쪽을 보여준다: 정지 > 시세 장애(소스 죽음) > 시세 지연(붐빔·저절로 회복) > 정상.
  // 시세 소스 상태는 판정 배치가 매 회차 남긴 도장(readSourceHealth)이라 새 호출이 없다.
  const ticks: StatusTick[] = ASSET_CLASSES.map((c) => {
    const paused = pause.global || (pause.byAssetClass[c] ?? false);
    const health = sourceHealth[c]?.health ?? null;
    let value: string;
    let tone: StatusTick['tone'];
    if (paused) {
      value = '판정 정지';
      tone = 'off';
    } else if (health === 'down') {
      value = '시세 장애';
      tone = 'off';
    } else if (health === 'slow') {
      value = '시세 지연';
      tone = 'idle';
    } else {
      value = '정상';
    }
    return { label: ASSET_CLASS_LABEL[c], value, ...(tone ? { tone } : {}) };
  });

  // 살아 있음 = 심박이 최근이고(stale 아님) 한 항목에 갇혀 있지도 않다.
  // 프로세스가 떠 있는 것과 일이 되는 것은 다르다 — 둘 다 봐야 한다
  const schedulerOk = !beat.stale && !beat.stuck;
  ticks.push({
    label: '스케줄러',
    value: beat.stale ? 'OFF' : beat.stuck ? '멈춤' : 'ON',
    tone: schedulerOk ? 'on' : 'off',
  });

  // **검수가 살아 있는가** — ARGOS와 검수 규칙 둘 다 봐야 한다 (2026-08-29 사용자 지시로
  // 통합. 그전엔 '검수 규칙'만 봤다). 정상 = 둘 다 정상 / 비정상 = 하나라도 문제.
  //
  // **스케줄러가 꺼져 있으면 '비활성'이다** — 두 상태는 박동으로 확인하는데(ARGOS 출근
  // 점검·검수 규칙 카나리아) 스케줄러가 안 돌면 그 점검이 안 돈다. 그때 초록/빨강으로
  // 단정하면 거짓말이 된다: 초록은 낡은 성공이고 빨강은 없는 사고다. 회색(비활성)이 맞다.
  //
  // 규칙은 **박동을 읽지 않고 직접 잰다**(정규식 6번, AI 0) — 실패 상태가 24시간 지나야
  // 낡음으로 드러나면 띠지가 하루 늦게 빨개진다. ARGOS는 사이드카 호출이 비싸(핑 9회) 여기선
  // 출근 박동(readAttendanceBeat.stale)만 읽는다 — "최근에 답했나"면 band엔 충분하다.
  if (beat.stale) {
    ticks.push({ label: '검수', value: '비활성', tone: 'idle' });
  } else {
    const canary = await runCanaryChecks(prisma).catch(() => null);
    const ruleOk = !!canary && canary.failures.length === 0;
    const argosOk = !attendance.stale;
    const bad = [!argosOk ? 'ARGOS' : null, !ruleOk ? '규칙' : null].filter(Boolean);
    ticks.push({
      label: '검수',
      value: bad.length === 0 ? '정상' : `비정상(${bad.join('·')})`,
      tone: bad.length === 0 ? 'on' : 'off',
    });
  }

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
