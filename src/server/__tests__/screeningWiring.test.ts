import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// **검수 문맥을 조립하는 곳은 빠짐없이 조립한다.**
//
// ── 왜 이것이 시험할 만한 성질인가 (2026-08-20 실제 사고) ──────────
// 13차에서 표기 회피 탐지를 붙이고 44건 코퍼스로 **게시 차단율 28% → 92%**를 측정했다.
// 그 숫자는 참이었지만 **탐침 스크립트에서만** 참이었다 — 운영 경로인 `screenReport`와
// 작성 중 사전 검사가 `applyRules(input)`를 문맥 없이 부르고 있었고, 문맥이 없으면
// 그 층은 설계대로 **침묵한다.** 즉 운영에서는 0%였다.
//
// 이 실패가 위험한 이유는 고장 나지 않기 때문이다. 예외도 경고도 없고 시험도 전부
// 초록이다 — `ctx.knownNames ?? new Set()`은 완벽하게 정상인 코드로 보인다.
// **조용한 무동작**은 이 저장소가 반복해서 만난 모양이다(9차 사이드카 유실, 8차
// 학습셋=채점지). 그때마다 답은 같았다: 사람의 주의가 아니라 코드가 지키게 한다.
//
// 그래서 값이 아니라 **자리**를 시험한다. 값(오탐률·탐지율)은 코퍼스가 재고,
// 이 시험은 그 코퍼스가 재는 대상이 실제로 운영에서 도는지를 잰다.

const SERVER_DIR = join(process.cwd(), 'src', 'server');
const APP_DIR = join(process.cwd(), 'src', 'app');

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : tsFiles(p);
    return name.endsWith('.ts') || name.endsWith('.tsx') ? [p] : [];
  });
}

/** `collectAutoScreenFindings(` / `runScreening(` 호출이 있는 파일 */
function callSites(): { file: string; src: string }[] {
  return [...tsFiles(SERVER_DIR), ...tsFiles(APP_DIR)]
    .map((file) => ({ file, src: readFileSync(file, 'utf-8') }))
    .filter(
      ({ file, src }) =>
        !file.endsWith('complianceService.ts') &&
        /(?:collectAutoScreenFindings|runScreening)\s*\(/.test(src),
    );
}

describe('검수 문맥 배선', () => {
  it('1차 검수를 부르는 모든 곳이 종목 마스터를 함께 넘긴다', () => {
    const missing = callSites()
      .filter(({ src }) => !src.includes('knownNames'))
      .map(({ file }) => file.replace(process.cwd(), ''));

    expect(
      missing,
      '표기 회피 탐지는 아는 이름 집합이 없으면 **아무 소견도 내지 않습니다**(설계). ' +
        '그래서 배선을 빠뜨려도 코드가 정상으로 보이고 시험도 초록입니다 — ' +
        '2026-08-20에 실제로 그 상태로 92%를 측정했고, 운영에서는 0%였습니다. ' +
        'getKnownInstrumentNames(prisma)를 문맥에 넣으십시오.',
    ).toEqual([]);
  });

  it('규칙 검사는 문맥을 받을 수 있는 형태로 남아 있다', () => {
    // applyRules 가 두 번째 인자를 잃으면 위 시험이 통과해도 신호는 다시 죽는다
    const compliance = readFileSync(
      join(process.cwd(), 'src', 'domain', 'compliance.ts'),
      'utf-8',
    );
    expect(compliance).toContain('export function applyRules(input: ScreeningInput, ctx: RuleContext');
  });

  it('종목 마스터 적재는 실패해도 검수를 세우지 않되 로그를 남긴다', () => {
    const loader = readFileSync(join(SERVER_DIR, 'instrumentNames.ts'), 'utf-8');
    // 던지면 검수 전체가 서고, 조용하면 꺼진 줄 아무도 모른다 — 둘 다 안 된다
    expect(loader).toContain('catch');
    expect(loader).toContain('console.error');
  });
});
