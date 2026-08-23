import { describe, expect, it } from 'vitest';
import {
  describeUnavailability,
  listUnavailability,
  type StudentHealth,
} from '../studentClient';

/**
 * **못 쓰는 이유를 전부 세는가** (2026-08-23 창업자 지시).
 *
 * `describeUnavailability` 는 첫 이유 하나만 돌려준다 — 알림 한 줄에는 그것이 맞다.
 * 계기판은 다르다: 지문도 어긋나고 카나리아도 깨진 상태에서 앞의 하나만 고치면 여전히
 * 결근인데, 화면이 **고치러 가기 전에** 그 사실을 말해 주지 않았다.
 *
 * 이 시험이 지키는 것 둘:
 *   ① 독립된 고장은 **함께** 나온다 (하나만 보고 돌아가지 않게)
 *   ② 문장은 **한 곳에서만** 만들어진다 (목록의 첫 항목 = 예전 함수의 답)
 */

const OK: StudentHealth = {
  ok: true,
  stub: false,
  tokenizerSha: 'abc123',
  trainedTokenizerSha: 'abc123',
  labels: [],
};

describe('listUnavailability — 결근 사유 항목화', () => {
  it('사이드카가 없으면 연결 불가 하나뿐이다 — 그 상태에서는 나머지를 잴 수 없다', () => {
    const rs = listUnavailability(null);
    expect(rs.map((r) => r.code)).toEqual(['OFFLINE']);
  });

  it('**독립된 고장은 함께 나온다** — 지문 + 카나리아', () => {
    const rs = listUnavailability({
      ...OK,
      ready: false,
      readyDetail: '라벨 순서가 다릅니다',
      trainedTokenizerSha: 'DIFFERENT',
    });
    expect(rs.map((r) => r.code)).toEqual(['CANARY', 'SHA']);
    // 배지에 쓸 짧은 이름이 서로 달라야 어디를 고칠지 갈린다
    expect(new Set(rs.map((r) => r.label)).size).toBe(2);
  });

  it('상태가 전부 멀쩡하면 핑만 남는다 — 그때만 소거법이 성립한다', () => {
    expect(listUnavailability(OK, '위반 문항 침묵').map((r) => r.code)).toEqual(['PING']);
  });

  it('**핑은 다른 고장과 함께 세지 않는다** — 상태에서 걸리면 핑을 돌지도 않았다', () => {
    const rs = listUnavailability({ ...OK, stub: true }, '이 값은 무시돼야 한다');
    expect(rs.map((r) => r.code)).toEqual(['STUB']);
    expect(rs.some((r) => r.sentence.includes('무시돼야'))).toBe(false);
  });

  it('지문 문장은 두 값을 함께 적는다 — "불일치"만으로는 어느 쪽을 고칠지 모른다', () => {
    const [r] = listUnavailability({ ...OK, trainedTokenizerSha: 'TRAINED' });
    expect(r.sentence).toContain('TRAINED');
    expect(r.sentence).toContain('abc123');
  });

  it('**문장은 한 곳에서만 만들어진다** — 예전 함수의 답 = 목록의 첫 항목', () => {
    const cases: [StudentHealth | null, string | undefined][] = [
      [null, undefined],
      [{ ...OK, stub: true }, undefined],
      [{ ...OK, modelStale: true }, undefined],
      [{ ...OK, ready: false, readyDetail: '사유' }, undefined],
      [{ ...OK, trainedTokenizerSha: 'X' }, undefined],
      [OK, '뇌사 의심'],
      [OK, undefined],
    ];
    for (const [h, ping] of cases) {
      expect(describeUnavailability(h, ping)).toBe(listUnavailability(h, ping)[0].sentence);
    }
  });
});
