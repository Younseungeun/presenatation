import { createSign } from 'node:crypto';
import type { PushPayload, PushProvider, PushResult, PushTarget } from './provider';

// Firebase Cloud Messaging HTTP v1 어댑터.
//
// **의존성을 새로 넣지 않았다** — firebase-admin은 이 한 가지 일에 비해 무겁고,
// 여기서 필요한 것은 ① 서비스 계정으로 액세스 토큰 받기 ② 메시지 POST 두 가지뿐이다.
// ①의 서명은 Node 기본 crypto의 RS256으로 끝난다.
//
// 레거시 서버 키(`https://fcm.googleapis.com/fcm/send`)를 쓰지 않은 이유: 구글이 종료했고,
// 그쪽은 키 하나가 곧 전권이라 유출 시 되돌릴 방법이 서비스 재발급뿐이다.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** 액세스 토큰 수명은 1시간 — 만료 1분 전에 미리 갈아 끼운다 */
const TOKEN_SKEW_MS = 60_000;
const SEND_TIMEOUT_MS = 8_000;

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  /** PEM 개인키. 환경 변수에 넣을 때 줄바꿈이 \n 두 글자로 들어오는 경우를 흡수한다 */
  privateKey: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * 시험 중에는 네트워크로 아무것도 내보내지 않는다.
 *
 * **가드는 fetch를 부르는 자리에 있어야 한다** — 스윕 쪽에 두면 시험용 공급자까지
 * 함께 막혀서 배달·정리 로직을 아예 시험할 수 없게 된다(실제로 처음에 그렇게 짰다가
 * 시험 두 개가 그 사실을 알려 줬다). opsAlert도 postWebhook·postTelegram 안쪽에 둔다.
 *
 * NODE_ENV가 아니라 VITEST를 보는 이유: NODE_ENV는 운영에서도 실수로 'test'가 될 수
 * 있지만 VITEST는 vitest가 켜 주는 값이라 **운영에서는 참이 될 수 없다.**
 */
function outboundBlocked(): boolean {
  return !!process.env.VITEST;
}

export class FcmPushProvider implements PushProvider {
  readonly id = 'fcm-v1';
  private readonly privateKey: string;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(private readonly config: FcmConfig) {
    // `FCM_PRIVATE_KEY="-----BEGIN...\n..."` 형태로 넣는 것이 가장 흔하다.
    // 실제 줄바꿈으로 넣은 경우도 그대로 통과한다
    this.privateKey = config.privateKey.replace(/\\n/g, '\n');
  }

  /** 서비스 계정 JWT → 액세스 토큰. 유효한 토큰이 남아 있으면 재사용한다 */
  private async getAccessToken(now = Date.now()): Promise<string> {
    if (this.accessToken && now < this.accessTokenExpiresAt - TOKEN_SKEW_MS) {
      return this.accessToken;
    }
    const iat = Math.floor(now / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = base64url(
      JSON.stringify({
        iss: this.config.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat,
        exp: iat + 3600,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claim}`);
    const signature = base64url(signer.sign(this.privateKey));
    const assertion = `${header}.${claim}.${signature}`;

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!res.ok) {
      throw new Error(`FCM 액세스 토큰 발급 실패 (${res.status}) — 서비스 계정 값을 확인하세요`);
    }
    const json = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = now + json.expires_in * 1000;
    return this.accessToken;
  }

  /**
   * FCM v1은 **한 요청에 한 대상**이다 (배치 엔드포인트는 종료됐다).
   * 그래서 대상마다 부르되 **병렬로** 보낸다 — 기기 몇 대 수준이라 순차로 돌 이유가 없다.
   */
  async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
    if (targets.length === 0) return [];
    // 시험: 성공한 척한다. 실패로 답하면 스윕이 죽은 구독을 지우기 시작하고,
    // 그러면 이 가드가 데이터를 바꾸는 셈이 된다 — 가드는 아무것도 바꾸면 안 된다
    if (outboundBlocked()) {
      return targets.map((t) => ({ subscriptionId: t.subscriptionId, ok: true, gone: false }));
    }
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (e) {
      // 인증이 실패하면 **전부 실패지만 아무것도 죽지 않았다** — 토큰을 지우면 안 된다
      const msg = e instanceof Error ? e.message : String(e);
      return targets.map((t) => ({ subscriptionId: t.subscriptionId, ok: false, gone: false, error: msg }));
    }
    return Promise.all(targets.map((t) => this.sendOne(token, t, payload)));
  }

  private async sendOne(
    accessToken: string,
    target: PushTarget,
    payload: PushPayload,
  ): Promise<PushResult> {
    const url = `https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`;
    // 플랫폼마다 "중요한 알림"을 표현하는 방식이 다르다. 급한 것만 소리를 내고
    // 나머지는 조용히 쌓이게 한다 — 전부 소리를 내면 아무것도 소리를 안 내는 것과 같다
    const message: Record<string, unknown> = {
      token: target.token,
      notification: { title: payload.title, body: payload.body },
      // 앱이 눌렸을 때 어디로 갈지. notification이 아니라 data로 보내야
      // 앱이 켜져 있을 때도 같은 값을 읽을 수 있다
      data: { link: payload.link ?? '/my/notifications' },
      android: { priority: payload.urgent ? 'HIGH' : 'NORMAL' },
      apns: {
        headers: { 'apns-priority': payload.urgent ? '10' : '5' },
        payload: { aps: { sound: payload.urgent ? 'default' : undefined } },
      },
      webpush: {
        fcmOptions: { link: payload.link ?? '/my/notifications' },
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      });
      if (res.ok) return { subscriptionId: target.subscriptionId, ok: true, gone: false };

      // **여기가 이 어댑터에서 가장 중요한 갈래다.**
      // 404 UNREGISTERED = 앱이 지워졌거나 토큰이 회전했다 → 지운다
      // 400 INVALID_ARGUMENT = 토큰 형식이 틀렸다 → 지운다 (재시도해도 영원히 같다)
      // 그 외(401·429·5xx) = 우리 잘못이거나 일시 장애 → 남겨 두고 다음에 다시
      const gone = res.status === 404 || res.status === 400;
      const text = await res.text().catch(() => '');
      return {
        subscriptionId: target.subscriptionId,
        ok: false,
        gone,
        error: `FCM ${res.status} ${text.slice(0, 200)}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { subscriptionId: target.subscriptionId, ok: false, gone: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }
}
