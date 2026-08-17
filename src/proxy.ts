import { NextResponse, type NextRequest } from 'next/server';

// 콘텐츠 보안 정책(CSP) — **XSS를 막는 자리는 여기다** (2026-08-17 검토 7차 Q2).
//
// ── 왜 여기서 막는가 ──────────────────────────────────────────
// 7차 검토에서 "생체 재확인 표를 세션에 묶어야 XSS를 막느냐"를 물었고, 답은
// **아니다**였다. XSS 코드는 공격자의 브라우저가 아니라 **운영자의 브라우저 안에서**
// 돈다. 세션 쿠키는 브라우저가 알아서 붙여 보내므로, 표를 세션에 묶어 봐야 같은
// 브라우저에서 나가는 요청은 그대로 통과한다. 세션 바인딩은 복잡도만 늘리고
// 이 상대에게는 아무것도 안 한다.
//
// 그 위협을 실제로 줄이는 층이 여기다: **주입된 스크립트가 애초에 실행되지 못하게
// 하는 것.** 방어를 관문에 한 겹 더 쌓는 대신, 관문 앞의 공격 자체를 없앤다.
//
// ── 논스(nonce) 방식을 쓰는 이유 ──────────────────────────────
// `script-src 'unsafe-inline'`은 CSP를 켰다는 기분만 준다 — 주입된 인라인 스크립트가
// 전부 통과하므로 막는 것이 없다. 요청마다 난수를 발급해 **우리가 심은 스크립트에만**
// 표를 붙이면, 공격자가 주입한 스크립트는 표가 없어 실행되지 않는다.
// Next가 이 응답 헤더를 읽어 자기 스크립트에 논스를 자동으로 붙인다.
//
// ── 인라인 *스타일*은 허용한다 (style-src-attr) ────────────────
// 화면 곳곳의 style={{...}}는 HTML의 style 속성으로 렌더된다. 이걸 막으면 화면이
// 무너지는데, 얻는 것은 거의 없다 — 스타일 속성으로는 자바스크립트가 실행되지 않는다.
// **막아야 할 것은 스크립트지 여백값이 아니다.** 대신 <style> 태그 쪽(style-src)은
// 논스를 요구한다.
//
// ── 개발 모드의 예외 ──────────────────────────────────────────
// React가 개발 중에는 eval로 서버 에러 스택을 복원한다. 운영에는 필요 없으므로
// 'unsafe-eval'은 개발에서만 켠다.

const TOSS = 'https://js.tosspayments.com https://*.tosspayments.com';

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  const csp = [
    `default-src 'self'`,
    // strict-dynamic: 표를 가진 스크립트가 불러오는 스크립트(토스 SDK)까지 이어서 허용한다.
    // 이걸 지원하는 브라우저는 뒤의 호스트 목록을 무시하고 논스만 본다 — 호스트를 함께
    // 적어 두는 것은 구형 브라우저용 대비책이다
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' ${TOSS}${isDev ? " 'unsafe-eval'" : ''}`,
    // 개발에서는 논스를 **빼고** 'unsafe-inline'을 준다. 둘을 같이 적으면 논스가 이기고
    // 'unsafe-inline'은 무시되는데(CSP 규칙), 개발 서버는 스타일을 <style> 태그로
    // 밀어 넣으므로 화면이 통째로 무너진다. 운영은 CSS 파일(<link>)이라 논스면 충분하다
    isDev ? `style-src 'self' 'unsafe-inline'` : `style-src 'self' 'nonce-${nonce}'`,
    // style={{...}}는 HTML의 style 속성으로 렌더된다 — 여기서 막으면 화면 곳곳의
    // 여백·색이 사라진다. 스타일 속성으로는 스크립트가 실행되지 않으므로 열어 둔다
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' blob: data:`,
    `font-src 'self'`,
    `connect-src 'self' ${TOSS}`,
    // 결제창은 토스가 띄운다
    `frame-src 'self' ${TOSS}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    // 주입된 <form>이 데이터를 밖으로 보내는 길을 막는다
    `form-action 'self'`,
    // 우리 화면을 남의 페이지에 끼워 넣고 클릭을 훔치는 짓(클릭재킹)을 막는다
    `frame-ancestors 'none'`,
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  // 브라우저가 파일 종류를 멋대로 추측하지 않게 — 업로드된 파일이 스크립트로 읽히는 길
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // 다른 사이트로 이동할 때 우리 주소의 경로·질의를 넘기지 않는다
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return response;
}

export const config = {
  matcher: [
    {
      // 정적 자산과 API에는 붙이지 않는다 — 화면(HTML)에만 의미가 있는 헤더다
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
