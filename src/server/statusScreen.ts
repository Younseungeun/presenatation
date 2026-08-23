import type { PrismaClient } from '@prisma/client';
import { CALENDAR_COVERAGE } from '@/domain/marketCalendar';
import { resolveCrossCheckMode } from '@/domain/crossCheck';
import { ASSET_CLASSES, ASSET_CLASS_LABEL } from '@/domain/constants';
import { getUiSettings } from '@/server/appSettings';
import { getPauseState } from '@/server/judgmentPause';
import { getOpsMetrics } from '@/server/opsMetrics';
import { isSoloOperatorMode } from '@/server/operatorApprovalService';
import { DAILY_OUTFLOW_LIMIT_KRW } from '@/server/payoutVelocity';
import { readHeartbeat } from '@/server/schedulerHealth';

// 상태 화면이 한 번에 읽는 것 (시안 v3 scr-status).
//
// **스케줄러는 계기판의 한 줄이 아니라 자기 자리를 갖는다.** 판정·마감·정산이 전부
// 이 프로세스 하나를 지나므로, 멈추면 돈이 움직이는 일이 통째로 멈춘다.
// 그리고 멈춤은 **두 얼굴**이다: 심장이 안 뛰는 것(프로세스가 죽음)과, 뛰는데 일이
// 안 되는 것(한 항목에 갇힘). 둘은 처방이 달라 한 줄로 합치면 안 된다.

export async function getStatusScreen(prisma: PrismaClient, now = new Date()) {
  const [beat, pause, metrics, settings, solo, manualLag] = await Promise.all([
    readHeartbeat(prisma, now),
    getPauseState(prisma),
    getOpsMetrics(prisma, now),
    getUiSettings(prisma),
    isSoloOperatorMode(prisma),
    // 자동 판정이 못 해서 사람 앞에 쌓인 카드 — 스케줄러가 도는데도 이게 늘면
    // 프로세스가 아니라 데이터가 막힌 것이다
    prisma.predictionCard.count({ where: { judgment: null, manualJudgmentOnly: true } }),
  ]);

  const pausedClasses = ASSET_CLASSES.filter(
    (c) => pause.global || (pause.byAssetClass[c] ?? false),
  );

  // 경보 = 지금 무엇이 아픈가. 지표의 alert와 판정 정지를 한 줄로 세운다 —
  // 둘 다 "지금 안 하면 무슨 일이 생기나"의 답이라 같은 자리에 있어야 한다
  const alerts: Array<{ level: 'P0' | 'WARN'; title: string; detail: string; href?: string }> = [];
  if (pausedClasses.length > 0) {
    alerts.push({
      level: 'P0',
      title: `${pausedClasses.map((c) => ASSET_CLASS_LABEL[c]).join(' · ')} 자동 판정 정지 중`,
      detail: '정지 중에도 14일 상한(전액 환불)은 계속 집행됩니다',
      href: '/admin/compliance?tab=inst',
    });
  }
  if (beat.stale) {
    alerts.push({
      level: 'P0',
      title: '스케줄러 심장박동 없음',
      detail: '판정·마감·정산이 전부 멈춰 있습니다 — 호스팅 콘솔에서 프로세스를 확인하세요',
    });
  } else if (beat.stuck) {
    alerts.push({
      level: 'P0',
      title: `스케줄러가 한 항목에 갇혀 있습니다 — ${beat.running ?? '알 수 없음'}`,
      detail: '프로세스는 살아 있는데 일이 안 되는 상태입니다',
    });
  }
  for (const m of metrics.filter((x) => x.alert)) {
    alerts.push({ level: 'WARN', title: m.label, detail: `${m.value} · ${m.sample}` });
  }

  // 달력이 만료되면 그때부터 "휴일이 없다"고 답한다 — 연휴에 판정하게 된다
  const calendarTo = Object.values(CALENDAR_COVERAGE)
    .map((c) => c.to)
    .sort()[0];

  return {
    alerts,
    scheduler: {
      alive: !beat.stale,
      stuck: beat.stuck,
      lastBeatAt: beat.lastBeatAt,
      ageMs: beat.ageMs,
      running: beat.running,
      runningForMs: beat.runningForMs,
      // **밀린 일** — 심장이 뛰고 일도 도는데 큐가 안 줄면 그것도 멈춤이다
      lag: manualLag,
    },
    dashboard: {
      pausedClasses,
      allClasses: ASSET_CLASSES,
      calendarTo,
      // 두 번째 소스가 실제로 도는 자산군 — 지금은 코인(빗썸)뿐이다.
      // 교차검증이 shadow면 기록만 하고 판정을 막지 않는다는 사실까지 함께 말한다
      crossCheckMode: resolveCrossCheckMode(process.env),
    },
    metrics,
    settings: {
      marketTicker: settings.marketTicker,
      marketTickerAmounts: settings.marketTickerAmounts,
      crossCheckMode: resolveCrossCheckMode(process.env),
      dailyLimitKrw: DAILY_OUTFLOW_LIMIT_KRW,
      // **값은 안 읽는다 — 있는지만 본다.** 토큰이 화면으로 나가면 그 순간 새는 것이다
      telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    },
    solo,
  };
}
