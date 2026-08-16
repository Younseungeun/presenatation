import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

// **숫자 상수는 근거와 함께 산다** — 값이 아니라 값의 이유를 코드에 남긴다.
//
// ── 왜 이 도구가 필요한가 ────────────────────────────────
// 41차까지 오면서 상수 하나를 바꿀 때마다 같은 일이 반복됐다: `EQUITY_SHORT_HORIZON_DAYS = 7`
// 이 왜 7인지 아무도 몰랐고(작성자인 나도 몰랐다), 그래서 시뮬레이션을 새로 돌려야 했고,
// 돌려 보니 **14가 맞았다.** 근거가 없는 값은 틀렸는지조차 알 수 없다.
//
// 그래서 규칙을 하나 둔다: **`src/`에서 밖으로 내보내는 숫자 상수에는 `@근거`를 붙인다.**
//
// ── 왜 "미기록" 태그를 코드에 두지 않는가 (검토안에서 한 걸음 더) ──
// 41차 검토는 `@근거 미기록`을 어휘에 넣고 그 개수를 CI가 세는 방식을 제안했다.
// 면제 목록(베이스라인) 방식은 그대로 받되, **`미기록`이라는 태그 자체는 없앤다.**
// 이유는 하나다 — 태그는 복사된다. 새 상수를 쓰는 사람은 옆 상수를 복사하는데,
// 옆에 `@근거 미기록`이 붙어 있으면 그것까지 따라온다. 그러면 빚이 코드 안에서
// 스스로 번식한다. 태그가 아예 없으면 복사할 것도 없고, 규칙은 더 단순해진다:
//
//   태그가 없다 = 반드시 `constants-debt.txt`에 이름이 있어야 한다.
//   목록에 없는 무태그 상수 = 실패. 목록에 있는데 태그가 생겼다 = 목록에서 지워라.
//
// 빚은 코드가 아니라 **한 파일에** 모여 있고, 그 파일의 줄 수가 남은 빚의 양이다.

export const BASIS_KINDS = ['시뮬', '규칙', '계약', '설계'] as const;
export type BasisKind = (typeof BASIS_KINDS)[number];

/**
 * 태그 뒤 이유의 최소 길이.
 *
 * "@근거 설계"만 적고 끝내면 태그가 도장이 된다. 사람이 한 줄이라도 쓰게 만드는
 * 최소값이고, 10자는 "참가 조건이라서" 정도가 겨우 들어가는 길이다.
 *
 * @근거 설계 태그가 도장으로 전락하지 않을 최소 분량
 */
export const BASIS_REASON_MIN_CHARS = 10;

export const DEBT_FILE = 'constants-debt.txt';

export type ConstantSite = {
  /** 저장소 기준 상대 경로 (POSIX 구분자) */
  file: string;
  name: string;
  line: number;
  /** `file:NAME` — 면제 목록의 키 */
  key: string;
  basis: { kind: string; reason: string } | null;
};

export type AuditResult = {
  /** 숫자 리터럴을 품은 export const 전부 */
  sites: ConstantSite[];
  /** 근거도 없고 면제 목록에도 없다 — 새로 생긴 빚 */
  untracked: ConstantSite[];
  /** 태그는 있는데 형식이 틀렸다 */
  malformed: { site: ConstantSite; why: string }[];
  /** 면제 목록에 있는데 근거가 생겼다 — 갚았으니 목록에서 지워라 */
  paid: ConstantSite[];
  /** 면제 목록에 있는데 그런 상수가 없다 — 이름이 바뀌었거나 지워졌다 */
  stale: string[];
  /** 면제 목록에 남아 있는 진짜 빚 */
  remaining: ConstantSite[];
};

const SCREAMING = /^[A-Z][A-Z0-9_]*$/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      return name === '__tests__' || name === '__fixtures__' || name === 'node_modules'
        ? []
        : tsFiles(p);
    }
    return (name.endsWith('.ts') || name.endsWith('.tsx')) && !name.endsWith('.d.ts') ? [p] : [];
  });
}

/**
 * 초기값 어딘가에 숫자 리터럴이 있는가.
 *
 * AST로 본다 — 문자열 안의 숫자('2026-01-01' 같은 휴장일 표)는 NumericLiteral이 아니므로
 * 저절로 빠진다. 라벨 표(`Record<Tier, string>`)도 마찬가지다. 정규식으로 훑었다면
 * 이 둘을 손으로 제외해야 했고, 그 예외 목록이 또 하나의 빚이 됐을 것이다.
 */
function hasNumericLiteral(node: ts.Node): boolean {
  if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.BigIntLiteral) return true;
  return (
    ts.forEachChild(node, (child) => {
      // 열쇠 자리의 숫자는 값이 아니다 — `{ 1: '하루', 2: '일주일' }`의 1·2는
      // 수익성 레벨이라는 **이름**이지 조절할 수 있는 값이 아니다. 이걸 빼지 않으면
      // 라벨 표가 전부 빚으로 잡히고, 그 순간 목록이 신호를 잃는다.
      if (
        (ts.isPropertyAssignment(child.parent) || ts.isEnumMember(child.parent)) &&
        child.parent.name === child
      ) {
        return false;
      }
      return hasNumericLiteral(child) ? true : undefined;
    }) ?? false
  );
}

/** 선행 주석에서 `@근거 <종류> <이유>`를 뽑는다. 여러 개면 첫 번째. */
function readBasis(full: string, node: ts.Node): { kind: string; reason: string } | null {
  const ranges = ts.getLeadingCommentRanges(full, node.getFullStart()) ?? [];
  for (const r of ranges) {
    const text = full.slice(r.pos, r.end);
    const m = /@근거\s+(\S+)[ \t]*(.*)/.exec(text);
    if (m) return { kind: m[1], reason: m[2].trim() };
  }
  return null;
}

export function scanConstants(root: string): ConstantSite[] {
  const srcDir = join(root, 'src');
  const sites: ConstantSite[] = [];

  for (const file of tsFiles(srcDir)) {
    const full = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, full, ts.ScriptTarget.Latest, true);
    const rel = relative(root, file).replace(/\\/g, '/');

    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      if (!(stmt.declarationList.flags & ts.NodeFlags.Const)) continue;

      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !SCREAMING.test(decl.name.text)) continue;
        if (!decl.initializer || !hasNumericLiteral(decl.initializer)) continue;

        // 태그는 선언 하나에 붙기도 하고(`const A = 1, B = 2`는 안 쓰지만)
        // 문장 전체에 붙기도 한다 — 둘 다 본다.
        const basis = readBasis(full, decl) ?? readBasis(full, stmt);
        sites.push({
          file: rel,
          name: decl.name.text,
          line: sf.getLineAndCharacterOfPosition(decl.name.getStart(sf)).line + 1,
          key: `${rel}:${decl.name.text}`,
          basis,
        });
      }
    }
  }
  return sites.sort((a, b) => a.key.localeCompare(b.key));
}

/** 면제 목록을 읽는다. `#`으로 시작하는 줄과 빈 줄은 주석. */
export function readDebtList(root: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(root, DEBT_FILE), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

export function auditConstants(root: string): AuditResult {
  const sites = scanConstants(root);
  const debt = new Set(readDebtList(root));
  const byKey = new Map(sites.map((s) => [s.key, s]));

  const untracked: ConstantSite[] = [];
  const malformed: { site: ConstantSite; why: string }[] = [];
  const paid: ConstantSite[] = [];
  const remaining: ConstantSite[] = [];

  for (const site of sites) {
    const listed = debt.has(site.key);
    if (!site.basis) {
      if (listed) remaining.push(site);
      else untracked.push(site);
      continue;
    }
    if (listed) paid.push(site);

    if (!(BASIS_KINDS as readonly string[]).includes(site.basis.kind)) {
      malformed.push({
        site,
        why: `종류가 "${site.basis.kind}" — ${BASIS_KINDS.join(' / ')} 중 하나여야 합니다`,
      });
    } else if (site.basis.reason.length < BASIS_REASON_MIN_CHARS) {
      malformed.push({
        site,
        why: `이유가 ${site.basis.reason.length}자 — ${BASIS_REASON_MIN_CHARS}자 이상 적어야 합니다`,
      });
    }
  }

  const stale = [...debt].filter((k) => !byKey.has(k)).sort();

  return { sites, untracked, malformed, paid, stale, remaining };
}
