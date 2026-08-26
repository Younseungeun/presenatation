// 사업계획서 HTML → PDF. 저장소에 새 의존성을 넣지 않으려고 이미 있는 playwright 를 쓰고,
// 브라우저도 내려받지 않고 **설치된 크롬**(channel: 'chrome')을 그대로 빌린다.
import { chromium } from 'playwright';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) {
  console.error('사용법: node makePdf.mjs <입력.html> <출력.pdf>');
  process.exit(1);
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();

/* **순서에 뜻이 있다.** 인쇄 모드를 먼저 켜고 열면 한글 웹폰트가 끝내 안 붙어
   본문이 시스템 폰트로 굳는다(첫 판이 그랬다). 화면 모드로 열어 폰트를 다 받은 뒤
   마지막에 인쇄로 바꾼다 — `@media print` 는 레이아웃 규칙이라 그때 적용해도 늦지 않다. */
await page.emulateMedia({ colorScheme: 'light' });
await page.goto(pathToFileURL(path.resolve(src)).href, { waitUntil: 'networkidle' });
/* **한글 웹폰트는 `fonts.ready` 만으로 부족하다.** 구글 폰트가 한글을 유니코드 구간별로
   쪼개 보내서, 해당 구간이 실제로 필요해지기 전에는 받지 않는다. 그대로 인쇄하면
   `fonts.ready` 는 이미 resolve 됐는데 본문만 시스템 폰트(맑은 고딕)로 굳는다 —
   실제로 첫 판이 그랬다. 그래서 **쓸 글자를 붙여** 강제로 받게 한다. */
await page.evaluate(async () => {
  const probe = '인투빌 사업계획서 검수 판정 리서처 0123456789';
  const wanted = [
    ['300 1em "IBM Plex Sans KR"', probe],
    ['400 1em "IBM Plex Sans KR"', probe],
    ['500 1em "IBM Plex Sans KR"', probe],
    ['700 1em "IBM Plex Sans KR"', probe],
    ['400 1em "Gowun Batang"', probe],
    ['700 1em "Gowun Batang"', probe],
    ['400 1em "IBM Plex Mono"', '0123456789%'],
    ['500 1em "IBM Plex Mono"', '0123456789%'],
    ['600 1em "IBM Plex Mono"', '0123456789%'],
  ];
  await Promise.all(wanted.map(([f, t]) => document.fonts.load(f, t).catch(() => {})));
  await document.fonts.ready;
});
// 폰트가 다 붙은 뒤에 종이 규칙으로 바꾼다
await page.emulateMedia({ media: 'print', colorScheme: 'light' });
/* **바꾼 뒤에 한 번 더 기다린다.** 인쇄 모드로 넘어가면 글자 크기·줄바꿈이 다시 잡히고,
   그때 필요해진 유니코드 구간을 새로 받는다. 여기서 안 기다리면 브라우저에서는
   멀쩡히 보이던 본문이 PDF 에서만 시스템 폰트로 굳는다 — 실측으로 확인한 순서다. */
await page.evaluate(async () => {
  const probe = '인투빌 사업계획서 검수 판정 리서처 등급 수수료 정산 예측 카드';
  await Promise.all(
    ['300', '400', '500', '600'].map((w) =>
      document.fonts.load(`${w} 1em "IBM Plex Sans KR"`, probe).catch(() => {}),
    ),
  );
  await document.fonts.ready;
});

await page.pdf({
  path: path.resolve(out),
  format: 'A4',
  printBackground: true, // 배경색 없이 뽑으면 표 머리글·인용 블록이 사라진다
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font-size:8px;color:#8b9a94;padding:0 15mm;' +
    'font-family:sans-serif;display:flex;justify-content:space-between;">' +
    '<span>인투빌 사업계획서 · 2026-08-25</span>' +
    '<span class="pageNumber"></span></div>',
  margin: { top: '16mm', right: '15mm', bottom: '18mm', left: '15mm' },
});

await browser.close();
console.log('만들었습니다:', path.resolve(out));
