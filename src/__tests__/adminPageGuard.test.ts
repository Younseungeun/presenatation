import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// **관리자 화면은 페이지마다 잠근다** (2026-08-23 실제 사고 뒤 추가).
//
// ── 무슨 일이 있었나 ────────────────────────────────────────
// `/admin/compliance` 는 OPERATOR 가 아니면 `notFound()` 인데, 그 계기판을 펼친 화면인
// `/admin/compliance/iris` 에는 관문이 없었다. **로그인 없이 200 이 떨어졌다** —
// 모델명·적재 지문·검수 정확도·운영자 판정 건수가 그대로 보였다.
//
// ── 왜 아무도 못 잡았나 ─────────────────────────────────────
// `admin/layout.tsx` 가 이름도 주석도 "전면 게이트"처럼 읽히지만 **인증 관문이 아니다.**
// 실제로 막는 것은 *운영자인데 패스키가 0개* 하나뿐이고 나머지는 통과시킨다:
//
//   if (!userId) return <>{children}</>;                 // 비로그인 → 그냥 그린다
//   if (me?.role !== "OPERATOR") return <>{children}</>; // 일반 이용자 → 그냥 그린다
//
// 의도된 설계다(각 페이지가 자기 `notFound()` 로 닫는다는 전제). 문제는 **레이아웃이
// 있으니 덮여 있겠지**로 읽힌다는 것이고, 실제로 그렇게 됐다.
//
// 시험 1,600건도 `tsc` 도 못 잡았다. **관문이 없는 것은 오류가 아니라 침묵이기
// 때문이다** — 화면은 멀쩡히 그려지고, 아무 예외도 나지 않는다. 근거 없는 상수가
// 틀렸다는 사실조차 알려 주지 않는 것과 같은 모양이라(constantBasis.test.ts),
// 처방도 같다: **사람이 기억하는 대신 시험이 확인한다.**
//
// ── 문서로 두지 않는 이유 ───────────────────────────────────
// `docs/admin-app-brief.md` §8-1 에도 적었지만, 문서는 새 화면을 만드는 순간에
// 읽히지 않는다. 이 시험은 **관문을 빠뜨린 파일이 생기는 그 순간** 빨개진다.

const ADMIN_DIR = path.join(process.cwd(), 'src/app/admin');

/** 화면을 그리지 않고 다른 곳으로 보내기만 하는 껍데기 — 샐 값이 없다 */
function isRedirectStub(src: string): boolean {
  // `redirect(...)` 를 부르면서 JSX 를 하나도 그리지 않는 파일
  return /\bredirect\s*\(/.test(src) && !/return\s*\(?\s*</.test(src);
}

/** 세션을 읽고 역할을 확인하는가 */
function hasGuard(src: string): boolean {
  const readsSession = /getSessionUserId|requireOperatorId/.test(src);
  // 세션만 읽고 역할을 안 보면 **로그인한 아무 이용자나** 들어온다
  const checksRole = /OPERATOR|requireOperatorId/.test(src);
  return readsSession && checksRole;
}

function adminPages(dir = ADMIN_DIR, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) adminPages(full, out);
    else if (e.name === 'page.tsx') out.push(full);
  }
  return out;
}

describe('관리자 화면 인증 관문', () => {
  const pages = adminPages();

  it('찾을 화면이 있다 — 경로가 바뀌면 이 시험이 조용히 0건을 통과한다', () => {
    // 빈 목록을 통과시키면 디렉터리 이름이 바뀐 날 이 시험이 아무것도 안 지킨다
    expect(pages.length).toBeGreaterThan(5);
  });

  it.each(pages.map((p) => [path.relative(process.cwd(), p).replace(/\\/g, '/'), p]))(
    '%s 은 스스로 잠근다',
    (_rel, file) => {
      const src = readFileSync(file, 'utf8');
      if (isRedirectStub(src)) return; // 껍데기는 면제 — 그릴 것이 없다
      expect(
        hasGuard(src),
        '관리자 화면에는 세션·역할 관문이 필요합니다. `admin/layout.tsx` 는 인증 관문이 ' +
          '아니라 패스키 부트스트랩 게이트라 비로그인·비운영자를 그대로 통과시킵니다. ' +
          '`src/app/admin/compliance/page.tsx` 머리 네 줄을 그대로 복사하십시오.',
      ).toBe(true);
    },
  );
});
