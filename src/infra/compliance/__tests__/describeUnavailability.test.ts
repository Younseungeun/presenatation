import { describe, expect, it } from 'vitest';
import { describeUnavailability, type StudentHealth } from '../studentClient';

// **학생이 왜 빠졌는지**를 만드는 한 곳. 장애 알림과 운영 계기판이 같은 문구를 쓴다.
//
// 이 시험이 붙잡는 것은 문구가 아니라 **가지가 하나도 사라지지 않는 것**이다. 사유가
// 비어 있으면 화면에는 "결근"만 남는데, 2026-08-22 에 실제로 그 상태였다 — 토크나이저
// 지문이 갈려 학생이 실집행에서 빠졌고 게시가 전부 보류됐는데, 원인을 알려면 사이드카를
// 직접 열어 봐야 했다.

const OK: StudentHealth = {
  ok: true,
  stub: false,
  tokenizerSha: 'aaaa',
  trainedTokenizerSha: 'aaaa',
  modelSha: 'mmmm',
  modelStale: false,
  ready: true,
};

describe('describeUnavailability', () => {
  it('사이드카가 안 뜨면 연결 실패로 말한다', () => {
    expect(describeUnavailability(null)).toContain('연결할 수 없습니다');
  });

  it('가중치 없이 토크나이저만 있으면 스텁이라고 말한다', () => {
    expect(describeUnavailability({ ...OK, stub: true })).toContain('스텁');
  });

  it('적재 뒤 파일이 바뀌었으면 옛 프로세스 가능성을 짚는다', () => {
    const msg = describeUnavailability({ ...OK, modelStale: true });
    expect(msg).toContain('바뀌었습니다');
    expect(msg).toContain('옛 프로세스');
  });

  it('카나리아 실패는 사이드카가 준 사유를 그대로 싣는다', () => {
    const msg = describeUnavailability({ ...OK, ready: false, readyDetail: '오차 3.2e-02' });
    expect(msg).toContain('카나리아 실패');
    expect(msg).toContain('오차 3.2e-02');
  });

  it('카나리아 사유가 비어도 문장이 깨지지 않는다', () => {
    expect(describeUnavailability({ ...OK, ready: false })).toContain('사유 없음');
  });

  // 2026-08-22 실사고 — 이 가지가 없어서 화면이 원인을 말하지 못했다
  it('토크나이저 지문 불일치는 두 값을 나란히 적는다', () => {
    const msg = describeUnavailability({
      ...OK,
      tokenizerSha: 'a053f457838bdbe0',
      trainedTokenizerSha: '032c3a06ebb26aa1',
    });
    expect(msg).toContain('토크나이저 지문 불일치');
    // **"불일치"만으로는 어느 쪽을 고쳐야 하는지 알 수 없다**
    expect(msg).toContain('032c3a06ebb26aa1');
    expect(msg).toContain('a053f457838bdbe0');
  });

  it('학습 지문을 안 주는 사이드카는 불일치로 몰지 않는다', () => {
    const msg = describeUnavailability({ ...OK, trainedTokenizerSha: undefined });
    expect(msg).not.toContain('토크나이저');
  });

  // **소거법 가지** — 상태 넷이 전부 멀쩡한데 못 쓴다면 남는 것은 핑뿐이다.
  // 이 성질 덕분에 `pingDetail` 을 모르는 호출자(계기판 API)도 같은 함수를 쓸 수 있다
  it('상태가 전부 정상이면 핑 실패로 본다', () => {
    expect(describeUnavailability(OK)).toContain('시맨틱 핑 실패');
  });

  it('핑 사유를 알면 그대로 싣는다', () => {
    const msg = describeUnavailability(OK, '정상 문장에 RUMOR 0.91 — 발작 의심');
    expect(msg).toContain('발작 의심');
  });

  it('핑 사유를 몰라도 빈 문장을 남기지 않는다', () => {
    const msg = describeUnavailability(OK, '');
    expect(msg).toContain('상태는 정상인데');
  });

  // 검사 순서가 뒤집히면 덜 구체적인 사유가 먼저 잡힌다 — 지문 불일치를 "핑 실패"로
  // 말하는 순간 운영자는 엉뚱한 곳을 고치게 된다
  it('여러 곳이 동시에 나가면 더 근본적인 것부터 말한다', () => {
    const broken: StudentHealth = {
      ...OK,
      stub: true,
      modelStale: true,
      ready: false,
      trainedTokenizerSha: 'zzzz',
    };
    expect(describeUnavailability(broken)).toContain('스텁');
    expect(describeUnavailability({ ...broken, stub: false })).toContain('바뀌었습니다');
    expect(describeUnavailability({ ...broken, stub: false, modelStale: false })).toContain(
      '카나리아',
    );
  });
});
