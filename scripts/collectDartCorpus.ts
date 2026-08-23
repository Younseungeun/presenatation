import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';

// **실제 한국어 금융 문장 대조군을 모은다** — 금감원 DART 공시 원문 (17차 U-5).
//   npm run corpus:dart -- --count 3000
//
// ── 왜 이것이 출시 전 마지막 관문인가 ────────────────────────────
// 지금 "오탐 0%"의 근거는 **우리가 손으로 쓴 54문장**이다. 그 대조군은 이미 두 번
// 뚫렸다(`3분기`·`2차전지` / `AI반도체`·`ESG경영`). 둘 다 한국어 리포트에서 가장 흔한
// 표기인데 우리가 생각을 못 해서 대조군에 없었다.
//
// **우리가 만든 대조군은 정의상 우리가 생각한 것만 담는다.** 그 벽은 실제 문장으로만
// 넘는다. 3,000건인 이유는 Rule of Three — 오탐률 0.1% 이하를 95% 신뢰로 말하려면
// 3/0.001 = 3,000 이 필요하다.
//
// ── 왜 DART 인가 ────────────────────────────────────────────────
// 저작권이 가장 깨끗하고(공시 원문), 금융 어휘·종목명·숫자 표기가 우리 리포트와 가깝다.
// 다만 **공시체는 분석 리포트체가 아니다** — 이 대조군이 재는 것은 "금융 한국어 일반"의
// 오탐률이지 "리서처가 쓰는 글"의 오탐률이 아니다. 그 차이는 출시 후 실데이터로 메운다.
//
// ── 보관 형태 ───────────────────────────────────────────────────
// 문장 단위로 섞어서 저장한다. 원문 문서를 복원할 수 없게 하려는 것이고, 어차피
// 우리가 재는 것은 문장 단위 오탐이라 문서 순서가 필요 없다.

const OUT = 'training/holdout/control-dart.jsonl';
const LIST_URL = 'https://opendart.fss.or.kr/api/list.json';
const DOC_URL = 'https://opendart.fss.or.kr/api/document.xml';

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? (process.argv[at + 1] ?? null) : null;
}

/**
 * 산문 판별 (2026-08-21 첫 실측 후 추가) — 공시 원문의 절반은 문장이 아니라 **표**다.
 *
 * 첫 수집분을 그대로 재니 오탐 15.1%가 나왔는데 대부분이 "제 품 명 제 품 설 명" ·
 * "(단위: 천원) 구 분 …" 같은 표 조각이었다 — 서식상의 글자 벌림이 회피 탐지(L6)에
 * 걸린 것. 이 대조군이 대표해야 할 모집단은 리서처의 **산문**(제목·요약·본문 텍스트
 * 필드)이지 표 서식이 아니므로, 표 조각은 모집단 밖이다.
 *
 * ⚠ 필터는 **형태로만** 정의한다 — "우리 규칙에 걸리는 것을 뺀다"로 정의하면
 * 대조군을 검사기에 맞추는 것이라(21차 Y-4형 함정) 측정이 자기 자신을 재게 된다.
 *   · 숫자 비율 ≥ 20% → 표·수치 나열       · 한 글자 어절 비율 ≥ 25% → 서식상 벌림
 *   · '(단위' 포함 → 표 머리               · 한글 비율 < 40% → 코드·기호 덩어리
 */
function isProse(s: string): boolean {
  const compact = s.replace(/\s+/g, '');
  if (compact.length === 0) return false;
  const digits = (compact.match(/[0-9]/g) ?? []).length / compact.length;
  const hangul = (compact.match(/[가-힣]/g) ?? []).length / compact.length;
  const words = s.split(/\s+/).filter(Boolean);
  const singleChar = words.filter((w) => w.length === 1).length / words.length;
  return digits < 0.2 && hangul >= 0.4 && singleChar < 0.25 && !s.includes('(단위');
}

/** 한국어 문장 분리 — 종결 어미 뒤 공백에서 자른다 */
function splitSentences(text: string): string[] {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+|(?<=(?:다|요|음|함|됨))\.\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15 && s.length <= 300 && /[가-힣]/.test(s) && isProse(s));
}

async function main() {
  const key = process.env.DART_API_KEY;
  if (!key) {
    console.log(`
DART_API_KEY 가 필요합니다.

  ① https://opendart.fss.or.kr 에서 인증키를 신청합니다 (무료, 즉시 발급)
  ② .env 에 한 줄 추가:
       DART_API_KEY=발급받은키
  ③ npm run corpus:dart -- --count 3000

무료 한도는 하루 20,000건이라 3,000문장에는 넉넉합니다.
`);
    process.exitCode = 1;
    return;
  }

  const want = Number(arg('count') ?? '3000');
  const sentences = new Map<string, string>();
  // 최근 공시 목록 → 문서 본문. 한 문서에서 여러 문장이 나오므로 목록은 적어도 된다
  const pages = Number(arg('pages') ?? '5');
  for (let page = 1; page <= pages && sentences.size < want; page += 1) {
    const list = await fetch(
      `${LIST_URL}?crtfc_key=${key}&page_no=${page}&page_count=100&pblntf_ty=A`,
    ).then((r) => r.json() as Promise<{ list?: { rcept_no: string }[]; message?: string }>);
    if (!list.list?.length) {
      console.log(`목록 응답에 문서가 없습니다: ${list.message ?? '(사유 없음)'}`);
      break;
    }
    for (const item of list.list) {
      if (sentences.size >= want) break;
      try {
        // **응답은 XML이 아니라 ZIP이다** (2026-08-21 첫 실전에서 발견 — 키 없이 쓴
        // 코드라 실행해 본 적이 없었고, 텍스트로 읽으면 압축 바이트에서 문장이 0건
        // 나온다). ZIP 안에 공시 원문 XML 파일들이 들어 있다.
        const buf = Buffer.from(
          (await fetch(`${DOC_URL}?crtfc_key=${key}&rcept_no=${item.rcept_no}`).then((r) =>
            r.arrayBuffer(),
          )) as ArrayBuffer,
        );
        let body = '';
        if (buf.subarray(0, 2).toString('latin1') === 'PK') {
          const AdmZip = (await import('adm-zip')).default;
          for (const entry of new AdmZip(buf).getEntries()) {
            // 공시 원문은 EUC-KR 계열(cp949)이 대부분이다 — utf-8 로 읽으면 한글이 깨져
            // splitSentences 의 /[가-힣]/ 필터에 전부 걸러진다
            const data = entry.getData();
            const utf8 = data.toString('utf-8');
            body +=
              (utf8.includes('�') ? new TextDecoder('euc-kr').decode(data) : utf8) + '\n';
          }
        } else {
          body = buf.toString('utf-8'); // 오류 응답(XML 메시지)은 그대로 — 문장이 안 나올 뿐
        }
        for (const s of splitSentences(body)) {
          if (sentences.size >= want) break;
          sentences.set(createHash('sha256').update(s).digest('hex').slice(0, 16), s);
        }
      } catch (e) {
        console.error(`  ${item.rcept_no} 실패:`, (e as Error).message);
      }
      process.stdout.write(`\r  문장 ${sentences.size}/${want}`);
    }
  }
  console.log('');

  // **섞어서 저장한다** — 원문 문서를 복원할 수 없게
  const rows = [...sentences.entries()].map(([id, text]) => ({ id, text }));
  for (let i = rows.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  mkdirSync('training/holdout', { recursive: true });
  writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  console.log(`\n→ ${OUT} (${rows.length.toLocaleString()}문장)`);
  console.log('\n다음: npm run eval:control\n');
}

main();
