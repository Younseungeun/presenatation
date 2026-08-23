import { describe, expect, it } from 'vitest';
import {
  RATCHET_KINDS,
  readCoverageSnapshot,
  ruleOnlyCoverage,
  type RatchetKind,
} from '../coverageMargin';

// **규칙을 좁히면 배포가 막힌다** (10차 검토 I-2).
//
// 10차에 드러난 사실: 규칙과 학생의 역할 분담은 설계가 아니라 **데이터 구성의 부작용**이다.
// 합성 학습셋에 직설(literal) 예시가 0건이라 학생의 직설 탐지가 50%인데, 규칙이 100%를
// 덮고 있어 합산에서는 아무 증상이 없다. 문서 유형(direction_flip·flip_under_risk)은
// 더 극단적이다 — 학생 기여가 **정확히 0%**이고 규칙이 전부다.
//
// 그 사실을 주석에 적어 두면 잊힌다. 여기서 숫자로 지킨다.
//
// ⚠ 이 시험은 **사이드카를 부르지 않는다.** 규칙은 결정적이라 언제 어디서든 같은 값이
// 나오고, 그래서 CI에서 돈다. 합산(운영에서 실제로 노출되는 값)의 라쳇은 `eval:student`
// 쪽에 있다 — 그쪽은 후퇴하면 스냅숏 기록 자체를 거부한다.

const snapshot = readCoverageSnapshot();

describe('교집합 보완율 라쳇', () => {
  it('스냅숏이 존재하고 어느 가중치로 쟀는지 적혀 있다', () => {
    // 없으면 이 시험 전체가 조용히 무력해진다 — "이름은 맞는데 내용이 없다"의 한 형태다
    expect(snapshot).not.toBeNull();
    // 파일 이름은 늘 model.onnx라 sha가 유일한 신원이다 (9차에 비싸게 배웠다)
    expect(snapshot?.modelSha).toMatch(/^[0-9a-f]{8,}$/);
  });

  it('스냅숏이 지금의 유형 목록을 전부 담고 있다', () => {
    // 유형을 새로 추가했는데 스냅숏이 옛것이면 그 유형은 아무도 안 지킨다
    expect(Object.keys(snapshot?.byKind ?? {}).sort()).toEqual([...RATCHET_KINDS].sort());
  });

  it.each(RATCHET_KINDS)('규칙 단독 탐지율이 후퇴하지 않는다 — %s', (kind: RatchetKind) => {
    if (!snapshot) return;
    const now = ruleOnlyCoverage()[kind] ?? 0;
    const before = snapshot.byKind[kind].rules;
    // 소수 오차만 허용한다. 정규식을 좁혀 이 값이 떨어지면 여기서 깨진다 —
    // 정당하게 통과시키려면 `npm run eval:student -- --write-snapshot`을 다시 돌려
    // **학생이 그 자리를 실제로 받았는지** 합산으로 증명해야 한다.
    expect(now).toBeGreaterThanOrEqual(before - 1e-9);
  });

  it.each(RATCHET_KINDS)('규칙+학생이 합산 커버리지를 여전히 설명할 수 있다 — %s', (kind: RatchetKind) => {
    if (!snapshot) return;
    const c = snapshot.byKind[kind];
    const now = ruleOnlyCoverage()[kind] ?? 0;
    // **필요조건이지 충분조건이 아니다.** 합집합은 덧셈보다 작거나 같으므로(둘이 같은
    // 문장을 잡으면 겹친다), 이 부등식을 통과해도 실제 합산은 떨어져 있을 수 있다.
    // 그래서 이것을 유일한 방어로 두지 않는다 — 위의 라쳇이 본체고 이쪽은 보조다.
    expect(now + c.student).toBeGreaterThanOrEqual(c.combined - 1e-9);
  });

  it('어느 유형이 한쪽에만 걸려 있는지가 기록에 남아 있다', () => {
    if (!snapshot) return;
    const soloRule = RATCHET_KINDS.filter(
      (k) => snapshot.byKind[k].student === 0 && snapshot.byKind[k].rules > 0,
    );
    const soloStudent = RATCHET_KINDS.filter(
      (k) => snapshot.byKind[k].rules === 0 && snapshot.byKind[k].student > 0,
    );
    // 값을 못 박지 않고 **모양**만 붙잡는다 (9차 G-6에서 정한 규율): 어느 쪽이든
    // 한쪽에만 의존하는 유형이 존재한다는 사실 자체가 이 시험이 필요한 이유다.
    // 양쪽 다 비면 분업이 사라진 것이고, 그건 좋은 소식이라도 다시 봐야 할 변화다.
    expect(soloRule.length + soloStudent.length).toBeGreaterThan(0);
  });
});
