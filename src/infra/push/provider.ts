// 푸시 공급자 추상화.
//
// 시세(MarketDataProvider)·본인인증(IdentityProvider)·임베딩(EmbeddingProvider)과 같은 패턴:
// 포트를 먼저 두고 어댑터를 갈아끼운다. 여기서는 "문구 + 토큰 → 배달" 만 책임진다.
//
// **왜 FCM 하나로 세 곳을 다 덮는가**: 인투빌은 앱스토어 앱(iOS·안드로이드)이면서
// 웹에서도 열린다. APNs·FCM·Web Push를 각각 붙이면 어댑터가 셋이고 실패 처리도 셋인데,
// FCM은 안드로이드는 직접, iOS는 APNs를 대신 거쳐, 웹은 Web Push 규격으로 배달한다.
// 우리 쪽 코드에서는 **토큰 문자열 하나**로 통일되고, 플랫폼 차이는 공급자 안에 갇힌다.

export interface PushTarget {
  token: string;
  platform: string;
  /** 실패했을 때 어느 구독을 지울지 — 우리 표의 행 id */
  subscriptionId: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /** 누르면 열릴 앱 안 경로 (예: /my/notifications) */
  link: string | null;
  urgent: boolean;
}

/**
 * 배달 결과.
 *
 * `gone`이 핵심이다 — 공급자가 "이 토큰은 더 이상 존재하지 않는다"고 답하는 경우
 * (앱 삭제·토큰 회전·기기 초기화)는 **재시도할 대상이 아니라 지울 대상**이다.
 * 이걸 일반 실패와 섞으면 죽은 토큰이 표에 영원히 남아 발송마다 헛돈다.
 */
export interface PushResult {
  subscriptionId: string;
  ok: boolean;
  /** 이 구독은 죽었다 — 즉시 삭제 */
  gone: boolean;
  error?: string;
}

export interface PushProvider {
  /** 어느 공급자로 보냈는지 로그·감사에 남긴다 */
  readonly id: string;
  /**
   * 한 번에 여러 대상에게. 배열로 받는 이유는 **한 사람이 여러 기기를 쓰기 때문**이고,
   * 결과도 대상마다 따로 돌려줘야 죽은 기기만 골라 지울 수 있다.
   */
  send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]>;
}

/**
 * 테스트용 공급자 — 보낸 것을 기억하고, 지정한 토큰은 실패시킨다.
 *
 * 네트워크를 흉내 내지 않는다. 이 코드베이스가 검증해야 하는 것은 배달이 아니라
 * **스윕·중복 방지·죽은 구독 정리·문구 규칙**이고, 그건 전부 우리 쪽 로직이다.
 */
export class FixturePushProvider implements PushProvider {
  readonly id = 'fixture';
  readonly sent: Array<{ targets: PushTarget[]; payload: PushPayload }> = [];

  constructor(
    /** 이 토큰들은 "죽었다"고 답한다 */
    private readonly goneTokens: Set<string> = new Set(),
    /** 이 토큰들은 일시 실패로 답한다 */
    private readonly failTokens: Set<string> = new Set(),
  ) {}

  async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
    this.sent.push({ targets, payload });
    return targets.map((t) => ({
      subscriptionId: t.subscriptionId,
      ok: !this.goneTokens.has(t.token) && !this.failTokens.has(t.token),
      gone: this.goneTokens.has(t.token),
      error: this.failTokens.has(t.token) ? '일시 실패 (fixture)' : undefined,
    }));
  }
}

/**
 * 기기마다 가는 길이 다르다 — **플랫폼으로 갈라 각자의 공급자에게 넘긴다.**
 *
 * 네이티브 기기는 FCM, 브라우저는 표준 Web Push다. 스윕은 이 사실을 몰라도 되고
 * (`send(targets)` 한 번이면 된다), 새 플랫폼이 생겨도 여기만 늘어난다.
 *
 * 길이 없는 플랫폼은 **실패로 답하되 죽었다고 하지 않는다** — 설정이 빠진 것과
 * 기기가 사라진 것은 다른 일이고, 후자로 취급하면 멀쩡한 구독이 지워진다.
 */
export class RoutingPushProvider implements PushProvider {
  readonly id: string;
  constructor(private readonly routes: { native?: PushProvider; web?: PushProvider }) {
    this.id = [routes.native?.id, routes.web?.id].filter(Boolean).join('+');
  }
  async send(targets: PushTarget[], payload: PushPayload): Promise<PushResult[]> {
    const web = targets.filter((t) => t.platform === 'web');
    const native = targets.filter((t) => t.platform !== 'web');
    const missing = (list: PushTarget[], why: string): PushResult[] =>
      list.map((t) => ({ subscriptionId: t.subscriptionId, ok: false, gone: false, error: why }));
    const [a, b] = await Promise.all([
      this.routes.native && native.length > 0
        ? this.routes.native.send(native, payload)
        : Promise.resolve(missing(native, 'FCM이 설정되지 않았습니다')),
      this.routes.web && web.length > 0
        ? this.routes.web.send(web, payload)
        : Promise.resolve(missing(web, 'Web Push가 설정되지 않았습니다')),
    ]);
    return [...a, ...b];
  }
}

/**
 * 운영 공급자 팩토리.
 *
 * 둘 중 **하나라도** 설정돼 있으면 그쪽으로는 나간다. 둘 다 없으면 null이고 푸시는
 * 완전히 비활성이다(인앱 알림은 그대로 쌓인다).
 *
 * "둘 다 있어야 켠다"로 하지 않은 이유: 웹만 먼저 붙이고 앱 껍데기는 나중에 만드는
 * 것이 실제 순서인데, 그때까지 웹 알림까지 막을 이유가 없다.
 */
export function createPushProviderFromEnv(env = process.env): PushProvider | null {
  // 어댑터는 필요할 때만 불러온다 — 설정이 없는 환경에서는 모듈이 평가되지 않는다
  let native: PushProvider | undefined;
  if (env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FcmPushProvider } = require('./fcm') as typeof import('./fcm');
    native = new FcmPushProvider({
      projectId: env.FCM_PROJECT_ID,
      clientEmail: env.FCM_CLIENT_EMAIL,
      privateKey: env.FCM_PRIVATE_KEY,
    });
  }
  let web: PushProvider | undefined;
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createWebPushFromEnv } = require('./webpush') as typeof import('./webpush');
    web = createWebPushFromEnv(env) ?? undefined;
  }
  if (!native && !web) return null;
  return new RoutingPushProvider({ native, web });
}
