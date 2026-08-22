import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudentClientFromEnv, SEMANTIC_PINGS } from '../studentClient';

/**
 * **첫 확인 뒤에 죽은 학생을 알아채는가** (2026-08-23 창업자 지적).
 *
 * `usable()` 의 걸쇠는 성공을 **프로세스 수명 내내** 캐시한다 — 리포트마다 `/health` 를
 * 부르지 않으려는 설계고, 그 자체는 맞다. 문제는 첫 확인 뒤에 사이드카가 죽었을 때다:
 *
 *   게시    막힘        ✓  studentFailed → studentDown (complianceService)
 *   계기판  "출근 ●"    ✗  걸쇠가 계속 참
 *   알림    안 나감      ✗  noteAvailability 는 usable() 안에서만 돈다
 *
 * 게시가 막히는 것은 정상 동작이라 **안전은 유지된다.** 다만 운영자에게는 보류 카드만
 * 쌓이고 **원인이 화면 어디에도 없다** — 계기판이 초록이니 사이드카를 의심할 이유가 없다.
 *
 * 파일을 따로 둔 이유: `studentClient.test.ts` 는 검수 모델 세션이 크게 손대는 중이라
 * 그 파일에 얹으면 두 작업이 한 커밋에 섞인다.
 */

const HEALTH = {
  ok: true,
  stub: false,
  tokenizer_sha: 'abc123',
  trained_tokenizer_sha: 'abc123',
  labels: [],
};

const SCREEN_BASE = { latency_ms: 5, token_count: 12, token_ids_head: [], stub: false };

/** 짧은 입력 — 문장 3개 미만이라 창 모드가 발동하지 않는다(호출이 정확히 1회) */
const SHORT_INPUT = {
  title: '',
  summary: '',
  content: '짧은 정상 문장 하나입니다.',
  assetClass: 'KR_EQUITY',
  assetName: '',
  direction: 'UP',
} as never;

/**
 * `/health` 와 `/screen` 을 가르는 라우팅 목 — `usable()` 이 시맨틱 핑 8문항을 돌리므로
 * 문항별로 옳은 답을 준다(위반 문항 → 그 라벨 고점, 정상 문항 → 침묵). 답을 틀리면
 * 뇌사·발작 관문에 걸려 이 시험이 재려는 것과 다른 이유로 결근이 된다.
 */
function mockHealth() {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!String(url).includes('/screen')) {
      return new Response(JSON.stringify(HEALTH), { status: 200 });
    }
    const text = (JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? '';
    const ping = SEMANTIC_PINGS.find((p) => text.includes(p.input.content));
    const findings = ping?.kind === 'violation' ? [{ category: ping.label, score: 0.91 }] : [];
    return new Response(JSON.stringify({ ...SCREEN_BASE, findings }), { status: 200 });
  });
}

/** 설정이 같으면 같은 객체가 돌아오므로(팩토리 캐시) 시험마다 URL을 달리한다 */
let seq = 0;
function env() {
  seq += 1;
  return { STUDENT_SIDECAR_URL: `http://127.0.0.1:${9500 + seq}` } as unknown as NodeJS.ProcessEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('걸쇠 무효화 — 소견 요청이 실패했을 때', () => {
  it('**캐시된 출근을 버린다** — 다시 재고 결근으로 돈다', async () => {
    let dead = false;
    const live = mockHealth();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (dead) throw new Error('ECONNREFUSED');
        return live(url, init);
      }),
    );
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(true);

    dead = true;
    // 캐시가 살아 있으므로 이 순간까지는 걸쇠가 여전히 참이다 — 여기까지가 예전 동작
    expect(await c.screen(SHORT_INPUT)).toBeNull();

    // 실제로 물었는데 대답이 없었다 = 헬스체크보다 강한 증거
    expect(await c.usable()).toBe(false);
  });

  it('소견이 정상으로 오면 캐시를 버리지 않는다 — 성공이 재조회를 부르면 호출이 두 배가 된다', async () => {
    const f = mockHealth();
    vi.stubGlobal('fetch', f);
    const c = createStudentClientFromEnv(env())!;
    await c.usable();
    const before = f.mock.calls.length;

    await c.screen(SHORT_INPUT);
    await c.usable();

    // /screen 1회만 늘어야 한다 — usable 이 다시 돌았다면 /health + 핑 8이 더 붙는다
    expect(f.mock.calls.length).toBe(before + 1);
  });
});
