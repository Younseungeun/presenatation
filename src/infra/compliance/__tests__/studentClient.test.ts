import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStudentClientFromEnv, SEMANTIC_PINGS } from '../studentClient';

// **라이브 진입 관문(usable)의 시험이다.**
//
// 그림자 모드에서는 지문이 어긋난 기록을 버리면 그만이었다(결측). 라이브에서는 그 소견이
// 리서처의 게시를 실제로 멈추므로, 어긋난 상태로 들어오는 길이 하나도 없어야 한다.
// 여기서 막지 못하면 예외가 나는 것이 아니라 **조용히 틀린 답으로 남의 게시를 막는다.**

const HEALTH = {
  ok: true,
  stub: false,
  tokenizer_sha: 'abc123',
  trained_tokenizer_sha: 'abc123',
  labels: [],
};

const SCREEN_BASE = {
  latency_ms: 5,
  token_count: 12,
  token_ids_head: [],
  stub: false,
};

/**
 * /health 와 /screen 을 가르는 라우팅 목 — usable() 이 8문항 핑(26차 CC-4)을 돌리므로
 * 문항별로 옳은 답을 돌려준다: 위반 문항 → 그 라벨 고점, 정상 문항 → 침묵.
 * `screen` 을 넘기면 **모든** /screen 이 그 응답을 받는다 (뇌사·발작 모의용).
 */
function mockHealth(body: Record<string, unknown>, screen?: Record<string, unknown>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (!String(url).includes('/screen')) {
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (screen) return new Response(JSON.stringify(screen), { status: 200 });
    const text = (JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? '';
    const ping = SEMANTIC_PINGS.find((p) => text.includes(p.input.content));
    const findings =
      ping?.kind === 'violation' ? [{ category: ping.label, score: 0.91 }] : [];
    return new Response(JSON.stringify({ ...SCREEN_BASE, findings }), { status: 200 });
  });
}

/** 설정이 같으면 같은 객체가 돌아오므로(캐시), 시험마다 URL을 달리해 섞이지 않게 한다 */
let seq = 0;
function env(over: Record<string, string> = {}) {
  seq += 1;
  return {
    STUDENT_SIDECAR_URL: `http://127.0.0.1:${9000 + seq}`,
    ...over,
  } as unknown as NodeJS.ProcessEnv;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('usable() — 실집행 관문', () => {
  it('지문이 같으면 쓸 수 있다', async () => {
    vi.stubGlobal('fetch', mockHealth(HEALTH));
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(true);
  });

  it('**지문이 다르면 쓸 수 없다** — 학습과 서빙의 토크나이저가 갈라진 상태', async () => {
    vi.stubGlobal('fetch', mockHealth({ ...HEALTH, trained_tokenizer_sha: 'DIFFERENT' }));
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(false);
  });

  it('스텁 모드(가중치 없음)는 쓸 수 없다 — 소견을 낼 수 없는 상태다', async () => {
    vi.stubGlobal('fetch', mockHealth({ ...HEALTH, stub: true, trained_tokenizer_sha: null }));
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(false);
  });

  it('**낡은 가중치를 물고 있으면 쓸 수 없다** — 9차에 실제로 일어난 사고', async () => {
    // 새 모델을 내보내고 사이드카를 다시 띄웠는데 옛 프로세스가 죽지 않은 상태.
    // 이름(model.onnx)도 토크나이저 지문도 그대로라 다른 검사는 전부 통과한다.
    vi.stubGlobal('fetch', mockHealth({ ...HEALTH, model_stale: true }));
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(false);
  });

  it('**카나리아를 통과하지 못했으면 쓸 수 없다** (9차 G-1)', async () => {
    // 가중치·라벨 순서·어휘 중 하나가 어긋난 상태. 이름과 지문은 전부 정상이라
    // 다른 검사는 통과한다 — 이 계열(이름은 맞는데 내용이 다르다)의 마지막 관문이다.
    vi.stubGlobal('fetch', mockHealth({ ...HEALTH, ready: false, ready_detail: '라벨 순서가 다릅니다' }));
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(false);
  });

  it('옛 사이드카(ready 필드 없음)는 준비된 것으로 본다 — 다른 관문이 이미 막는다', async () => {
    vi.stubGlobal('fetch', mockHealth(HEALTH));
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(true);
  });

  it('사이드카가 죽어 있으면 쓸 수 없다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(false);
  });

  it('통과한 결과는 캐시된다 — 리포트마다 /health를 부르면 호출이 두 배가 된다', async () => {
    const f = mockHealth(HEALTH);
    vi.stubGlobal('fetch', f);
    const c = createStudentClientFromEnv(env())!;
    await c.usable();
    await c.usable();
    await c.usable();
    // 첫 usable 이 /health 1 + 시맨틱 핑 8문항(/screen) — 이후는 전부 캐시다
    expect(f).toHaveBeenCalledTimes(1 + SEMANTIC_PINGS.length);
  });

  it('**뇌사는 쓸 수 없다** — 상태가 전부 정상인데 고정 위반 문장에 침묵 (22차 Y-1(b))', async () => {
    // 22차가 지목한 gap 17형 함정의 재현: 가중치가 깨져 무엇을 넣어도 소견 0인 모델은
    // HTTP 200·지문·카나리아 플래그 아래에서 정상 모델과 완벽히 같은 값이다.
    // 이 시험은 옛 usable()(상태 플래그만)에서 실제로 **통과했다** — 시맨틱 핑이 막는다.
    vi.stubGlobal('fetch', mockHealth(HEALTH, { ...SCREEN_BASE, findings: [] }));
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(false);
    // 사유는 **잰 쪽**에 묻는다 — 알림은 두 번 연속 실패해야 나가므로(B안) 첫 실패에서
    // `consumeAvailabilityChange()` 는 비어 있다. 여기서 재는 것은 알림이 아니라 판별력이다
    expect(c.failureReasons?.()[0]?.sentence).toContain('시맨틱 핑');
  });

  it('**발작은 쓸 수 없다** — 무엇을 넣어도 고점을 뱉는 모델은 위반 핑을 전부 통과한다 (26차 CC-4)', async () => {
    // 상수 출력(발작) 모델의 재현: 모든 /screen 에 PROFIT_GUARANTEE 0.93 을 돌려준다.
    // 위반 4문항은 전부 잡는 것처럼 보이고, **정상 문항에서만** 정체가 드러난다 —
    // 위반·정상 대비쌍이 짝수로 있어야 하는 이유가 이 시험이다.
    vi.stubGlobal(
      'fetch',
      mockHealth(HEALTH, { ...SCREEN_BASE, findings: [{ category: 'PROFIT_GUARANTEE', score: 0.93 }] }),
    );
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(false);
    expect(c.failureReasons?.()[0]?.sentence).toContain('발작');
  });

  it('핑 호출 자체가 죽어도 쓸 수 없다 — 못 잰 지능은 없는 지능으로 친다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes('/screen')) throw new Error('ECONNRESET');
        return new Response(JSON.stringify(HEALTH), { status: 200 });
      }),
    );
    const c = createStudentClientFromEnv(env())!;
    expect(await c.usable()).toBe(false);
  });
});

describe('createStudentClientFromEnv', () => {
  it('URL이 없으면 null — 기능이 통째로 꺼진다', () => {
    expect(createStudentClientFromEnv({} as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it('같은 설정이면 같은 객체 — 관문 캐시가 인스턴스에 붙어 있기 때문', () => {
    const e = env();
    expect(createStudentClientFromEnv(e)).toBe(createStudentClientFromEnv(e));
  });

  it('임계값이 다르면 다른 판정기다 — reviewerId에 값이 박힌다', () => {
    const base = env().STUDENT_SIDECAR_URL as string;
    const a = createStudentClientFromEnv({
      STUDENT_SIDECAR_URL: base,
      STUDENT_THRESHOLD: '0.5',
    } as unknown as NodeJS.ProcessEnv)!;
    const b = createStudentClientFromEnv({
      STUDENT_SIDECAR_URL: base,
      STUDENT_THRESHOLD: '0.7',
    } as unknown as NodeJS.ProcessEnv)!;
    expect(a).not.toBe(b);
    expect(a.reviewerId).not.toBe(b.reviewerId);
  });

  it('CARD_MISMATCH는 기본 졸업 목록에 없다 — 구조적 제외 (8차 E-5)', () => {
    // reviewerId의 /L7 이 켜진 라벨 수다. 8이 되는 날 이 시험이 걸린다 —
    // 그 라벨이 켜지면 리스크를 성실히 쓴 리포트가 가장 많이 막힌다
    const c = createStudentClientFromEnv(env())!;
    expect(c.reviewerId).toContain('/L7');
  });
});

describe('consumeAvailabilityChange — 상태 엣지 (9차 G-2)', () => {
  it('정상 기동은 알리지 않는다 — 잘 도는 것은 사건이 아니다', async () => {
    vi.stubGlobal('fetch', mockHealth(HEALTH));
    const c = createStudentClientFromEnv(env())!;
    await c.usable();
    expect(c.consumeAvailabilityChange()).toBeNull();
  });

  it('처음부터 못 쓰는 상태는 알린다 — 가장 조용한 실패다 (다만 두 번 재고 나서)', async () => {
    vi.stubGlobal('fetch', mockHealth({ ...HEALTH, ready: false, ready_detail: 'x' }));
    const c = createStudentClientFromEnv(env())!;
    await c.usable();
    // 첫 실패는 아직 사건이 아니다 (B안)
    expect(c.consumeAvailabilityChange()).toBeNull();
    await c.recheck!();
    expect(c.consumeAvailabilityChange()?.to).toBe(false);
  });

  it('**같은 상태가 이어지면 다시 알리지 않는다** — 경보 피로를 막는 것이 이 장치의 전부다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const c = createStudentClientFromEnv(env())!;
    await c.usable();
    await c.recheck!();
    expect(c.consumeAvailabilityChange()?.to).toBe(false);
    // 세 번째·네 번째 실패도 전이가 아니다 — 이미 결근이라고 말했다
    await c.recheck!();
    await c.recheck!();
    expect(c.consumeAvailabilityChange()).toBeNull();
  });

  it('한 번 꺼내면 사라진다 — 같은 전이로 두 번 울리지 않는다', async () => {
    vi.stubGlobal('fetch', mockHealth({ ...HEALTH, stub: true }));
    const c = createStudentClientFromEnv(env())!;
    await c.usable();
    await c.recheck!();
    expect(c.consumeAvailabilityChange()).not.toBeNull();
    expect(c.consumeAvailabilityChange()).toBeNull();
  });

  /**
   * **한 번의 헛걸음은 결근이 아니다** (2026-08-23 창업자 확정 B안).
   *
   * 실제로 04:49 에 `The operation was aborted due to timeout` 하나로 결근 문자가
   * 나가고 04:54 에 복귀 문자가 또 나갔다. 사이드카는 멀쩡했고 원인은 그 순간 CPU 를
   * 다 쓰던 시험이었다. 그런 문자가 몇 번 반복되면 진짜 결근에도 폰을 안 본다.
   */
  describe('결근 선언 — 두 번 연속이어야 한다 (B안)', () => {
    /** 부를 때마다 답이 바뀌는 사이드카 — 첫 회 실패, 그다음 정상 */
    const flaky = (fail: boolean[]) => {
      let n = 0;
      return vi.fn(async (url: string, init?: RequestInit) => {
        const down = fail[Math.min(n, fail.length - 1)];
        if (String(url).endsWith('/health')) n += 1;
        if (down) throw new Error('The operation was aborted due to timeout');
        return mockHealth(HEALTH)(url, init);
      });
    };

    it('첫 실패는 집행을 막되 알리지 않는다 — 게시는 이미 보류로 간다', async () => {
      vi.stubGlobal('fetch', flaky([true]));
      const c = createStudentClientFromEnv(env())!;
      // **집행은 유예하지 않는다** — 못 미더운 모델에게 판정을 맡기느니 보류가 낫다
      expect(await c.usable()).toBe(false);
      expect(c.consumeAvailabilityChange()).toBeNull();
      // 화면은 "확인 중" — 근무 중도 결근도 아니다
      expect(c.attendance?.()).toEqual({ ok: true, pendingFailure: true });
    });

    it('사이에 한 번이라도 응답하면 없던 일이 된다 — 04:49 사건이 이 줄이다', async () => {
      vi.stubGlobal('fetch', flaky([true, false]));
      const c = createStudentClientFromEnv(env())!;
      await c.usable();
      expect(await c.recheck!()).toBe(true);
      // 문자가 한 통도 나가지 않는다 — 결근을 선언한 적이 없으므로 복귀도 없다
      expect(c.consumeAvailabilityChange()).toBeNull();
      expect(c.attendance?.()).toEqual({ ok: true, pendingFailure: false });
    });

    it('두 번 연속이면 결근이다 — 유예는 미루기지 덮기가 아니다', async () => {
      vi.stubGlobal('fetch', flaky([true]));
      const c = createStudentClientFromEnv(env())!;
      await c.usable();
      await c.recheck!();
      expect(c.consumeAvailabilityChange()?.to).toBe(false);
      expect(c.attendance?.()).toEqual({ ok: false, pendingFailure: false });
    });

    it('회복은 즉시 알린다 — 한 번이라도 응답하면 그건 헛걸음이 아니라 사실이다', async () => {
      vi.stubGlobal('fetch', flaky([true, true, false]));
      const c = createStudentClientFromEnv(env())!;
      await c.usable();
      await c.recheck!();
      expect(c.consumeAvailabilityChange()?.to).toBe(false);
      expect(await c.recheck!()).toBe(true);
      expect(c.consumeAvailabilityChange()?.to).toBe(true);
    });
  });
});

describe('screen() 창 분할 (27차 DD-1 ① — 토큰 희석 방어)', () => {
  const SCREEN_EMPTY = { ...SCREEN_BASE, findings: [] };

  function mockWindowed() {
    // 통짜(긴 텍스트)는 침묵(희석 모의), "마지막 위반" 문장이 든 창만 고점을 돌려준다
    return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes('/screen')) {
        return new Response(JSON.stringify(HEALTH), { status: 200 });
      }
      const text = (JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? '';
      const findings =
        text.includes('제가 전액 물어드립니다') && text.length < 200
          ? [{ category: 'PROFIT_GUARANTEE', score: 0.88 }]
          : [];
      return new Response(JSON.stringify({ ...SCREEN_BASE, findings }), { status: 200 });
    });
  }

  const LONG_INPUT = {
    title: '',
    summary: '',
    content:
      '회사의 배당정책은 정관과 이사회 결의에 따라 운영됩니다. ' +
      '이번 분기 매출은 전년 대비 소폭 증가했습니다. ' +
      '원가 부담은 하반기까지 이어질 전망입니다. ' +
      '설비 투자는 계획된 범위 안에서 집행되고 있습니다. ' +
      '손해 보시면 제가 전액 물어드립니다.',
    assetClass: 'KR_EQUITY',
    assetName: '',
    direction: 'UP',
  } as never;

  it('긴 문서의 끝에 숨은 위반을 창이 건진다 — 통짜가 침묵해도 소견이 남는다', async () => {
    vi.stubGlobal('fetch', mockWindowed());
    const c = createStudentClientFromEnv(env())!;
    const out = await c.screen(LONG_INPUT);
    const pg = out?.findings.find((f) => f.category === 'PROFIT_GUARANTEE');
    expect(pg).toBeDefined();
    expect(pg?.confidence).toBeCloseTo(0.88, 2);
  });

  it('짧은 입력(3문장 미만)은 창을 만들지 않는다 — 채점지·핑·DART 경로 불변', async () => {
    const f = mockWindowed();
    vi.stubGlobal('fetch', f);
    const c = createStudentClientFromEnv(env())!;
    await c.screen({
      title: '', summary: '', content: '짧은 정상 문장 하나입니다.',
      assetClass: 'KR_EQUITY', assetName: '', direction: 'UP',
    } as never);
    // /screen 정확히 1회 — 창 모드 미발동
    expect(f.mock.calls.filter((a) => String(a[0]).includes('/screen'))).toHaveLength(1);
  });

  it('창 하나의 호출 실패는 결측이다 — 문서 전체 결과를 죽이지 않는다', async () => {
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (!String(url).includes('/screen')) return new Response(JSON.stringify(HEALTH), { status: 200 });
        n += 1;
        if (n === 3) throw new Error('ECONNRESET'); // 창 중 하나만 실패
        const text = (JSON.parse(String(init?.body ?? '{}')) as { text?: string }).text ?? '';
        const findings =
          text.includes('제가 전액 물어드립니다') && text.length < 200
            ? [{ category: 'PROFIT_GUARANTEE', score: 0.88 }]
            : [];
        return new Response(JSON.stringify({ ...SCREEN_BASE, findings }), { status: 200 });
      }),
    );
    const c = createStudentClientFromEnv(env())!;
    const out = await c.screen(LONG_INPUT);
    expect(out).not.toBeNull();
    expect(out?.findings.some((f) => f.category === 'PROFIT_GUARANTEE')).toBe(true);
  });
});

describe('splitForWindows — 구두점 없는 글 (2026-08-22 실측 결함)', () => {
  it('마침표 없는 공시체 긴 글도 종결어미에서 잘린다 — 안 자르면 창이 문서 전체가 된다', async () => {
    const { splitForWindows } = await import('../studentClient');
    const content =
      '회사는 정관에 따라 배당을 실시하고 있습니다 ' +
      '이번 분기 매출은 전년 대비 증가했습니다 ' +
      '원가 부담은 하반기까지 이어질 전망입니다 ' +
      '설비 투자는 계획된 범위에서 집행되고 있습니다 ' +
      '손해 보시면 제가 전액 물어드립니다';
    const parts = splitForWindows({ title: '', summary: '', content });
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts[parts.length - 1]).toContain('물어드립니다');
  });

  it('짧은 조각은 어미로 더 자르지 않는다 — "…하다 보니"류 중간 분절 방지', async () => {
    const { splitForWindows } = await import('../studentClient');
    const parts = splitForWindows({ title: '', summary: '', content: '실적을 보다 보니 기대가 커졌습니다. 다만 변동성은 큽니다.' });
    expect(parts).toEqual(['실적을 보다 보니 기대가 커졌습니다.', '다만 변동성은 큽니다.']);
  });
});
