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
// **설정이 없으면 조용히 넘어간다.** 알림 채널이 없다고 결제나 정산이 실패하면 안 된다 —
// 이 함수는 본업의 곁가지고, 곁가지가 본업을 죽이는 것이 가장 나쁘다.

const WEBHOOK_URL = process.env.OPS_WEBHOOK_URL;
/** 웹훅이 느려도 본업을 붙잡지 않는다 */
const WEBHOOK_TIMEOUT_MS = 5_000;

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
  await Promise.all([writeInAppNotifications(prisma, alert), postWebhook(alert)]);
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
  if (!WEBHOOK_URL) return; // 설정 안 됐으면 아무 일도 없다
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${alert.title}*\n${alert.body}` }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    // 웹훅 실패는 로그로만 — 이것 때문에 결제·정산이 실패하면 본말이 전도된다
    console.error('운영자 웹훅 실패:', e);
  }
}
