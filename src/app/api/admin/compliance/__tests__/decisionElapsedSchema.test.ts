import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// **텔레메트리가 판정을 막지 않는다** — 라우트 스키마의 `decisionElapsedMs` 가 지켜야 하는 성질.
//
// 왜 이 시험이 있나: `.catch(undefined)` 가 없던 동안 범위 밖 값 하나가 판정 요청
// **전체**를 400 으로 떨어뜨렸다. 금요일에 카드를 펼쳐 두고 월요일에 누르면 경과가
// 하루를 넘어 승인이 아예 안 됐고, 화면에는 이유가 안 나와 카드를 닫았다 다시 열기
// 전까지 계속 실패했다. 라우트 주석이 "텔레메트리가 판정을 막으면 안 된다"라고
// 적혀 있는데 코드가 그 반대였다 — 주석은 아무것도 막지 못한다.
//
// 스키마 정의를 여기에 다시 적지 않고 라우트에서 가져오면 좋겠지만, 라우트 모듈은
// import 만으로 prisma·세션까지 끌고 온다. 대신 **형태를 복사하고 그 사실을 못 박는다**:
// 라우트 쪽을 고치면서 여기를 안 고치면 아래 경계 시험이 그대로 통과해 버리므로,
// 라우트의 상수와 같은 값을 쓰는지 눈으로 확인할 것 (86_400_000).
const decisionElapsedMs = z
  .number()
  .int()
  .positive()
  .max(86_400_000)
  .optional()
  .catch(undefined);

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('APPROVE'),
    reportId: z.string().min(1),
    decisionElapsedMs,
  }),
]);

function parse(elapsed?: unknown) {
  const body: Record<string, unknown> = { action: 'APPROVE', reportId: 'r1' };
  if (arguments.length > 0) body.decisionElapsedMs = elapsed;
  return bodySchema.safeParse(body);
}

describe('판정 요청의 decisionElapsedMs', () => {
  it('정상 범위는 그대로 실린다', () => {
    const r = parse(13_235);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.decisionElapsedMs).toBe(13_235);
  });

  it('하루 정각까지는 측정으로 받는다', () => {
    const r = parse(86_400_000);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.decisionElapsedMs).toBe(86_400_000);
  });

  // 여기가 이 파일의 이유다 — 아래 넷은 전부 "판정은 성립하고 시간만 빈 칸"이어야 한다
  it.each([
    ['하루를 1ms 넘김', 86_400_001],
    ['금요일에 펼쳐 두고 월요일에 누름', 62 * 3_600_000],
    ['0 — 시계 오류', 0],
    ['음수', -5],
    ['숫자가 아님', 'abc'],
  ])('%s → 판정은 통과하고 시간만 버린다', (_label, value) => {
    const r = parse(value);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.decisionElapsedMs).toBeUndefined();
  });

  it('아예 안 보내도 판정은 통과한다', () => {
    const r = parse();
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.decisionElapsedMs).toBeUndefined();
  });

  // **버리는 것이 삼키는 것이 되면 안 된다** — 판정 자체의 오류는 그대로 막혀야 한다.
  // 이 시험이 없으면 위의 관대함이 스키마 전체로 번져도 아무도 모른다
  it('판정 자체가 잘못된 요청은 그대로 거부된다', () => {
    expect(bodySchema.safeParse({ action: 'APPROVE', reportId: '' }).success).toBe(false);
    expect(bodySchema.safeParse({ action: 'APPROVE' }).success).toBe(false);
  });

  // 하루를 넘는 값을 **상한으로 접지 않는** 이유: 그건 측정이 아니라 방치라
  // (탭을 열어 둔 채 퇴근 — decisionSpeedService.MAX_ELAPSED_MS 의 근거),
  // 접어 넣으면 재지도 않은 것을 "24시간 숙고"로 적게 된다. 빈 칸으로 두어야
  // getApprovedElapsedCoverage 가 "못 쟀다"로 세어 화면에 적는다
  it('하루를 넘는 값을 상한으로 접지 않는다', () => {
    const r = parse(62 * 3_600_000);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.decisionElapsedMs).not.toBe(86_400_000);
  });
});
