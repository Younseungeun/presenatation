import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRules } from '../compliance';
import type { RiskCategory } from '../compliance';
import { CANARY_PHRASE,
  SCREENING_CANARY, canaryInput, checkCanary } from '../screeningCanary';

// 카나리아 문항 자체가 옳은지 여기서 확인한다.
// **운영에서 이 문항이 빨개지면 검수가 죽은 것**이라, 문항이 처음부터 틀려 있으면
// 카나리아가 늘 빨갛거나(경보 피로) 늘 초록이다(무용). 둘 다 최악이다.

const known = new Set(['삼성sdi', '삼성전자', 'sk하이닉스']);

describe('규칙 검수 카나리아', () => {
  it('층마다 정확히 한 건씩 있다 — 한 층이 죽으면 한 건이 빨개져야 한다', () => {
    const layers = SCREENING_CANARY.map((c) => c.layer);
    for (const l of ['원문', '기호제거', '깊은정규화', '훼손신호'] as const) {
      expect(layers.filter((x) => x === l), l).toHaveLength(1);
    }
    // 정상 문항은 둘 — 미탐만 보면 "전부 잡는" 고장이 초록으로 지나간다
    expect(layers.filter((x) => x === '정상문항').length).toBeGreaterThanOrEqual(2);
  });

  it('지금 파이프라인에서 전부 통과한다', () => {
    for (const c of SCREENING_CANARY) {
      const got = applyRules(canaryInput(c), { knownNames: known, phrases: [CANARY_PHRASE] }).map((f) => f.category);
      expect(checkCanary(c, got), `${c.layer}/${c.id}: ${c.meaning}`).toBeNull();
    }
  });

  it('종목 마스터를 안 넘기면 훼손신호 문항이 빨개진다 — 이번 사고를 잡는 자리', () => {
    const c = SCREENING_CANARY.find((x) => x.layer === '훼손신호');
    expect(c).toBeDefined();
    const got = applyRules(canaryInput(c!), {}).map((f) => f.category);
    const fail = checkCanary(c!, got);
    expect(fail, '문맥 없이 불렀는데 통과했다면 이 카나리아는 배선을 못 잡는다').not.toBeNull();
    expect(fail!.missing).toContain('SCREENING_EVASION');
  });

  it('정상 문항은 소견이 하나라도 있으면 실패한다', () => {
    const normal = SCREENING_CANARY.find((c) => c.expect.length === 0)!;
    expect(checkCanary(normal, ['PROFIT_GUARANTEE' as RiskCategory])).not.toBeNull();
  });

  it('모든 문항이 무엇을 잃는지 적고 있다 — 알림에 그대로 실린다', () => {
    for (const c of SCREENING_CANARY) expect(c.meaning.length).toBeGreaterThan(10);
  });
});

describe('카나리아는 코퍼스에서 차출한다 (15차 S-4)', () => {
  // 규칙을 고칠 때 카나리아를 규칙에 맞춰 고치면, 카나리아는 규칙이 무엇을 하든 초록이다
  // — '규칙이 도는가'가 아니라 '규칙을 복사해 둔 시험이 도는가'를 재게 된다.
  // 그래서 문항을 손으로 쓰지 않고 **고정된 과거 공격 원문**을 그대로 쓴다.
  const corpus = new Set(
    (JSON.parse(
      readFileSync(join(process.cwd(), 'training', 'holdout', 'evasion-13.json'), 'utf-8'),
    ) as { t: string }[]).map((x) => x.t),
  );

  it('원문 층 말고는 전부 홀드아웃 코퍼스의 실제 문장이다', () => {
    const handwritten = SCREENING_CANARY.filter((c) => !corpus.has(c.content)).map((c) => c.layer);
    // 원문 층만 예외다 — 그 코퍼스는 전부 회피 표기라 '직설 위반'이 없다
    // 사전입력 문항도 예외다 — **합성 표식이어야만** 배선 고장과 빈 사전을 가를 수 있다
    expect(handwritten).toEqual(['원문', '사전입력']);
  });
});

describe('사전 입력 배선 카나리아 (20차 Q6)', () => {
  const phraseCase = SCREENING_CANARY.find((c) => c.layer === '사전입력')!;

  it('표식을 주입하면 잡힌다 — 사전 원천(learned) 소견으로', () => {
    const findings = applyRules(canaryInput(phraseCase), {
      knownNames: known,
      phrases: [CANARY_PHRASE],
    });
    expect(findings.some((f) => f.source === 'learned')).toBe(true);
    expect(checkCanary(phraseCase, findings.map((f) => f.category))).toBeNull();
  });

  it('표식 없이 부르면 빨개진다 — 이것이 배선 고장을 잡는 자리다', () => {
    const got = applyRules(canaryInput(phraseCase), { knownNames: known }).map((f) => f.category);
    const fail = checkCanary(phraseCase, got);
    expect(fail, 'phrases 배선 없이 통과했다면 이 카나리아는 아무것도 못 잡는다').not.toBeNull();
  });

  it('표식은 코드 규칙에 안 걸린다 — 걸리면 배선 고장이 초록으로 가려진다', () => {
    const got = applyRules(canaryInput(phraseCase), { knownNames: known });
    expect(got).toHaveLength(0);
  });
});

describe('화면은 층 목록을 따로 들고 있으면 안 된다 (2026-08-21 실제 사고)', () => {
  // 관리자 띠지가 층 이름을 배열로 박아 뒀다. 서버가 `사전입력` 문항을 늘렸을 때
  // **화면은 5칸을 그대로 그렸고 타입 에러도 나지 않았다** — 별도 배열이라 union이
  // 늘어도 컴파일러가 볼 자리가 없다. 늘어난 층이 죽어도 띠지는 초록이었다.
  //
  // 카나리아가 잡으려는 고장(**조용히 꺼진 채 초록**)을 카나리아 화면이 똑같이 저질렀다.
  // 값이 아니라 **자리**를 시험한다 — screeningWiring.test.ts 와 같은 사고방식이다.

  const layers = [...new Set(SCREENING_CANARY.map((c) => c.layer))];

  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) return name === '__tests__' ? [] : tsFiles(p);
      return /\.tsx?$/.test(name) ? [p] : [];
    });
  }

  it('화면 어디에도 층 이름을 둘 이상 문자열로 적지 않는다', () => {
    // **`SCREENING_CANARY` 를 import 했다고 면제하지 않는다.** 사고 당시 그 파일은
    // 이미 import 하고 있었다(정상 문항 개수를 세느라). 즉 "import 했으니 파생했겠지"는
    // 참이 아니고, 면제를 두면 이 시험은 자기가 잡으려던 사고를 그대로 통과시킨다.
    // 층 목록에서 뽑아 쓰면 이름 문자열은 **한 개도** 필요 없다.
    const offenders = tsFiles(join(process.cwd(), 'src', 'app'))
      .map((file) => ({ file, src: readFileSync(file, 'utf-8') }))
      // 층 이름 하나가 우연히 문장에 들어가는 것("원문 보기")은 잡지 않는다.
      // **둘 이상**을 따옴표로 적었다면 그건 층 목록을 옮겨 적은 것이다
      .filter(
        ({ src }) =>
          layers.filter((l) => src.includes(`'${l}'`) || src.includes(`"${l}"`)).length >= 2,
      )
      .map(({ file }) => file);

    expect(offenders, '층 목록을 옮겨 적지 말고 SCREENING_CANARY 에서 뽑으십시오').toEqual([]);
  });
});
