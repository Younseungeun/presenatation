import webpush from 'web-push';
import type { PushPayload, PushProvider, PushResult, PushTarget } from './provider';

// 브라우저 푸시(Web Push) 어댑터 — **FCM과 나란히 선다.**
//
// 왜 둘인가: 인투빌은 앱스토어 앱이면서 웹에서도 열린다(CLAUDE.md §3.5 "결제는 웹,
// 소비는 앱"). 네이티브 기기는 FCM이 배달하지만, 브라우저는 **표준 Web Push**로 바로
// 닿는다 — 중간에 FCM을 끼우면 브라우저용 SDK를 얹어야 하고 그만큼 웹 번들이 커진다.
//
// 그리고 이쪽은 **콘솔에서 받아 올 값이 없다.** VAPID 열쇠 한 쌍을 우리가 만들면 끝이라
// (npm run setup:webpush) 오늘 당장 진짜 알림을 눈으로 확인할 수 있다.
//
// 토큰 자리에는 브라우저가 준 구독 객체(JSON 문자열)가 통째로 들어간다 — endpoint와
// 두 열쇠(p256dh·auth)가 한 덩어리라 쪼개 저장할 이유가 없다. FCM 토큰이 문자열 하나인
// 것과 모양이 달라 보이지만, 우리 쪽에서는 **똑같이 "이 기기의 주소"** 한 칸이다.

/**
 * 시험 중에는 네트워크로 아무것도 내보내지 않는다 (fcm.ts와 같은 가드, 같은 이유).
 * 가드는 **실제로 밖으로 나가는 자리**에 있어야 한다.
 */
function outboundBlocked(): boolean {
  return !!process.env.VITEST;
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  /** VAPID 규격이 요구하는 연락처 — 배달 문제 시 푸시 서비스가 연락할 곳 */
  subject: string;
}

interface BrowserSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export class WebPushProvider implements PushProvider {
  readonly id = 'web-push';

  constructor(private readonly config: WebPushConfig) {
    webpush.setVapidDetails(config.subject, config.publicKey, config.privateKey);
  }

  async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
    if (targets.length === 0) return [];
    if (outboundBlocked()) {
      return targets.map((t) => ({ subscriptionId: t.subscriptionId, ok: true, gone: false }));
    }
    // 서비스 워커가 그대로 읽는 모양으로 보낸다 (public/push-sw.js와 짝)
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      link: payload.link ?? '/my/notifications',
      urgent: payload.urgent,
    });

    return Promise.all(
      targets.map(async (t): Promise<PushResult> => {
        let sub: BrowserSubscription;
        try {
          sub = JSON.parse(t.token) as BrowserSubscription;
        } catch {
          // 우리가 저장한 값이 깨졌다 — 재시도해도 영원히 같으므로 지운다
          return { subscriptionId: t.subscriptionId, ok: false, gone: true, error: '구독 형식 오류' };
        }
        try {
          await webpush.sendNotification(sub, body, {
            // 급한 것만 즉시 깨운다. 나머지는 배터리를 아끼며 배달돼도 좋다
            urgency: payload.urgent ? 'high' : 'normal',
            TTL: payload.urgent ? 60 * 30 : 60 * 60 * 6,
          });
          return { subscriptionId: t.subscriptionId, ok: true, gone: false };
        } catch (e) {
          // **404·410이 이 어댑터의 핵심 갈래다** — 브라우저가 구독을 버렸다는 뜻이라
          // (알림 차단·데이터 삭제·기기 초기화) 재시도 대상이 아니라 삭제 대상이다
          const status = (e as { statusCode?: number }).statusCode;
          const gone = status === 404 || status === 410;
          return {
            subscriptionId: t.subscriptionId,
            ok: false,
            gone,
            error: `WebPush ${status ?? ''} ${e instanceof Error ? e.message : String(e)}`.slice(0, 200),
          };
        }
      }),
    );
  }
}

export function createWebPushFromEnv(env = process.env): WebPushProvider | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  return new WebPushProvider({
    publicKey,
    privateKey,
    subject: env.VAPID_SUBJECT ?? 'mailto:ops@intovill.app',
  });
}
