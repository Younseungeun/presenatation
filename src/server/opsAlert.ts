import type { PrismaClient } from '@prisma/client';

// 운영자 경보 — **앱 밖으로 나간다.**
//
// 지금까지 운영자 알림은 Notification 행을 만드는 것이 전부였다. 코드 여러 곳에
// "이 알림이 유일한 발견 경로"라고 적어 놓고, 정작 그 경로가 **앱 안에만** 있었다.
// 돈이 PG에 묶였거나(REQUIRES_MANUAL_VOID) 환불이 멈춘 것은 운영자가 앱을 열어야
// 알 수 있는 일이 아니다 — 자는 사이에 나면 아침까지 아무도 모른다.
//
// 그래서 웹훅을 하나 둔다. 슬랙 incoming webhook 형식({"text": ...})이 사실상 표준이라
// 디스코드·구글챗·자체 수신기도 대부분 그대로 받는다.
//
// **채널은 텔레그램으로 확정 (2026-08-18 창업자 결정)** — TELEGRAM_BOT_TOKEN +
// TELEGRAM_CHAT_ID를 채우면 봇이 폰 푸시로 보낸다. 슬랙 형식 웹훅(OPS_WEBHOOK_URL)도
// 그대로 남는다 — 다인 체제로 넘어가면 팀 채널을 하나 더 꽂는 자리다. 채워진 쪽만
// 나가고, 둘 다 채우면 둘 다 나간다.
//
// **설정이 없으면 조용히 넘어간다.** 알림 채널이 없다고 결제나 정산이 실패하면 안 된다 —
// 이 함수는 본업의 곁가지고, 곁가지가 본업을 죽이는 것이 가장 나쁘다.

const WEBHOOK_URL = process.env.OPS_WEBHOOK_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
/** 웹훅이 느려도 본업을 붙잡지 않는다 */
const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * **시험 중에는 앱 밖으로 한 통도 내보내지 않는다** (2026-08-18, 실제 사고 뒤 추가).
 *
 * 텔레그램을 붙인 날 밤, `npm test` 한 번에 창업자 폰으로 **가짜 경보 수십 통**이
 * 갔다. 시험이 만드는 값("AAA 종목", "newcomer", 8,000원 보상)이 실제 경보 채널에
 * 그대로 흘러간 것이다.
 *
 * 왜 여태 안 드러났나 — `OPS_WEBHOOK_URL`이 한 번도 설정된 적이 없어 `postWebhook`이
 * 늘 조용히 빠져나갔다. 채널을 실제로 연결하는 순간 잠재해 있던 경로가 살아났다.
 *
 * 왜 시험에 값이 있나 — **Prisma Client가 `.env`를 스스로 읽는다.** vitest는 .env를
 * 안 읽지만(유닛 갈래에서는 값이 없다), DB 갈래는 PrismaClient를 임포트하는 순간
 * `.env` 전체가 `process.env`에 얹힌다. 시험 설정을 아무리 봐도 안 보이는 이유다.
 *
 * `VITEST`로 판단하는 이유: 시험 실행기 자신이 켜는 값이라 **운영에서 참이 될 수 없다.**
 * `NODE_ENV`는 사람이 실수로 넘길 수 있고, 그러면 경보가 조용히 멈춘다 — 알림 채널의
 * 침묵은 "사고 없음"과 구별되지 않으므로 그 위험을 지는 판단은 쓰지 않는다.
 *
 * 앱 **안** 알림(Notification 행)은 그대로 쓴다 — 시험이 그것을 검사하고, 밖으로
 * 나가지도 않는다. 막는 것은 네트워크뿐이다.
 */
function outboundBlocked(): boolean {
  return !!process.env.VITEST;
}

export interface OpsAlert {
  /** 한 줄 제목 — 휴대폰 알림에 그대로 뜬다 */
  title: string;
  /** 본문. 콘솔에서 처리를 끝낼 수 있게 열쇠(paymentKey·orderId)와 금액을 담는다 */
  body: string;
  /** 앱 안에서 열 화면 */
  link?: string;
  /** 알림 유형 (Notification.type) */
  type?: string;
  /**
   * 같은 사건을 반복해서 알리지 않기 위한 키.
   *
   * **결제처럼 뜨거운 경로에서 부를 때는 반드시 준다.** 시세 공급자가 빠진 상태로
   * 초당 수십 명이 결제를 누르면 같은 사고를 초당 수십 번 알리게 되고, 그 순간
   * 알림 채널이 죽어 **정작 다른 사고를 못 받는다**. 사고 하나에 알림 하나면 충분하다.
   */
  dedupeKey?: string;
  /** 같은 키를 다시 알리기까지의 시간 (기본 10분) */
  dedupeMs?: number;
}

/** 최근에 보낸 dedupeKey → 보낸 시각 */
const recentAlerts = new Map<string, number>();
const DEFAULT_DEDUPE_MS = 10 * 60_000;

function shouldSkip(alert: OpsAlert): boolean {
  if (!alert.dedupeKey) return false;
  const window = alert.dedupeMs ?? DEFAULT_DEDUPE_MS;
  const last = recentAlerts.get(alert.dedupeKey);
  const now = Date.now();
  if (last !== undefined && now - last < window) return true;
  recentAlerts.set(alert.dedupeKey, now);
  // 키가 무한정 쌓이지 않게 지난 것을 걷어낸다
  if (recentAlerts.size > 200) {
    for (const [k, at] of recentAlerts) {
      if (now - at >= window) recentAlerts.delete(k);
    }
  }
  return false;
}

/**
 * 운영자 전원에게 알린다 — 앱 안 알림 + 외부 웹훅 **둘 다.**
 * 어느 쪽이 실패해도 다른 쪽은 나가고, 둘 다 실패해도 던지지 않는다(호출자의 본업 보호).
 */
export async function notifyOperators(prisma: PrismaClient, alert: OpsAlert): Promise<void> {
  if (shouldSkip(alert)) return;
  await Promise.all([writeInAppNotifications(prisma, alert), postWebhook(alert), postTelegram(alert)]);
}

/**
 * 오래된 알림을 지운다 (스케줄러가 하루 한 번 부른다).
 *
 * **읽은 것만, 그리고 운영 경보는 남긴다.** 안 읽은 알림을 지우면 그 사람이 결국
 * 못 본 것이 되고, `OPS_ALERT`는 사고 이력이라 지우면 "언제부터 이랬나"를 못 센다.
 * 지우는 목적은 용량이 아니라 **P0 경보가 잡음에 묻히지 않게** 하는 것이다.
 */
export async function purgeOldNotifications(
  prisma: PrismaClient,
  now = new Date(),
  keepDays = 90,
): Promise<number> {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  const { count } = await prisma.notification.deleteMany({
    where: { readAt: { not: null }, createdAt: { lt: cutoff }, type: { not: 'OPS_ALERT' } },
  });
  return count;
}

async function writeInAppNotifications(prisma: PrismaClient, alert: OpsAlert): Promise<void> {
  try {
    const operators = await prisma.user.findMany({
      where: { role: 'OPERATOR' },
      select: { id: true },
    });
    if (operators.length === 0) return;
    await prisma.notification.createMany({
      data: operators.map((o) => ({
        userId: o.id,
        type: alert.type ?? 'OPS_ALERT',
        title: alert.title,
        body: alert.body,
        link: alert.link ?? '/admin/settlements',
      })),
    });
  } catch (e) {
    console.error('운영자 인앱 알림 실패:', e);
  }
}

async function postWebhook(alert: OpsAlert): Promise<void> {
  if (outboundBlocked()) return;
  if (!WEBHOOK_URL) return; // 설정 안 됐으면 아무 일도 없다
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${alert.title}*\n${alert.body}` }),
        signal: controller.signal,
      });
      // 거절도 **소리를 내야 한다** — fetch는 400에도 예외를 안 던진다
      if (!res.ok) console.error(`운영자 웹훅 거절: HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // 웹훅 실패는 로그로만 — 이것 때문에 결제·정산이 실패하면 본말이 전도된다
    console.error('운영자 웹훅 실패:', e);
  }
}

async function postTelegram(alert: OpsAlert): Promise<void> {
  if (outboundBlocked()) return;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return; // 설정 안 됐으면 아무 일도 없다
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // parse_mode를 주지 않는다 — 마크다운 모드는 본문의 *·_ 하나에 **메시지 전체가
        // 거절**된다. 경보 본문은 자유 문장이라 이스케이프에 기대면 언젠가 새고,
        // 새는 날이 하필 사고 나는 날이다. 평문이면 항상 도착한다
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: `${alert.title}\n${alert.body}`,
        }),
        signal: controller.signal,
      });
      // ── 거절은 조용히 지나가면 안 된다 (2026-08-18 연결 시험에서 발견) ──
      // fetch는 "chat not found"·"토큰 폐기됨"에도 **예외를 던지지 않는다.** 검사하지
      // 않으면 방 번호가 바뀌거나 토큰을 재발급한 날부터 경보가 통째로 사라지는데
      // 아무도 모른다 — 알림 채널의 침묵은 "사고 없음"과 구별되지 않는다.
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { description?: string } | null;
        console.error(
          `운영자 텔레그램 거절: HTTP ${res.status}${body?.description ? ` — ${body.description}` : ''}` +
            ' (TELEGRAM_CHAT_ID·TELEGRAM_BOT_TOKEN을 확인하세요)',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error('운영자 텔레그램 알림 실패:', e);
  }
}
