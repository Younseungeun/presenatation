import { prisma } from '../src/server/db';
import { findContactNumbers } from '../src/domain/contactNumber';
import { instrumentSpans } from '../src/domain/evasionNormalize';

// 16차 T-3/T-4 — 연락처 묶음 모양 판별과 종목명 마스킹 비율을 잰다.
// npm run probe:contact
const LOOSE = /(?<!\d)01[016789]\d{7,8}(?!\d)/;
const collapse = (t: string) => t.normalize('NFKC').replace(/(\d)[\s.\-–—_·]+(?=\d)/g, '$1');

async function main() {
  const rows = await prisma.instrument.findMany({ select: { name: true, ticker: true } });
  const known = new Set(rows.flatMap((r) => [r.name.toLowerCase(), r.ticker.toLowerCase()]));
  const tickers = rows.map((r) => r.ticker).filter((t) => /^\d+$/.test(t));
  const YEARS = Array.from({ length: 60 }, (_, i) => String(1990 + i));
  const UNITS = ['년', '년 전망', '월', '일', '원', '억원', '만주', '% 상승', '포인트', '건'];

  let loose = 0, shaped = 0, n = 0;
  for (const t of tickers) for (const y of YEARS) for (const u of UNITS) {
    const s = `${t} ${y}${u}`; n += 1;
    if (LOOSE.test(collapse(s))) loose += 1;
    if (findContactNumbers(s).length > 0) shaped += 1;
  }
  console.log(`\n═══ T-3 연락처 오탐 (티커 ${tickers.length} × 연도 60 × 단위 ${UNITS.length} = ${n.toLocaleString()}건) ═══`);
  console.log(`  공백 걷고 정규식만  오탐 ${loose.toLocaleString()}건 (${(loose / n * 100).toFixed(2)}%)`);
  console.log(`  **묶음 모양 판별**  오탐 ${shaped.toLocaleString()}건 (${(shaped / n * 100).toFixed(3)}%)`);

  console.log('\n[잡혀야 함]');
  for (const s of ['010-8923-7890', '01089237890', '010 8923 7890', '０１０-８９２３-７８９０', '0 1 0 - 8 9 2 3 - 7 8 9 0'])
    console.log(`  ${findContactNumbers(s).length ? '○' : '✗'}  "${s}"`);
  console.log('\n[통과해야 함]');
  for (const s of ['삼성에스디에스(018260) 2026년 전망', '010040 1990년 상장', '표 2 열 0 행 10', '2026-08-20 실적', '1,234억원 매출'])
    console.log(`  ${findContactNumbers(s).length ? '✗' : '○'}  "${s}"`);

  console.log('\n═══ T-4 종목명 마스킹 비율 ═══');
  console.log('  검토는 30% 상한을 제안했으나 **정상 문장이 이미 그 위**다:');
  for (const s of [
    '삼성전자 3분기 실적을 분석했습니다',
    'LG에너지솔루션과 SK하이닉스를 비교합니다',
    '루시드 다이어그노스틱스 3분기 전망',
    '삼성전자 SK하이닉스 LG에너지솔루션 현대차 NAVER 카카오 셀트리온 비교',
  ]) {
    const covered = instrumentSpans(s, known).reduce((a, [x, y]) => a + (y - x), 0);
    console.log(`  ${(covered / s.length * 100).toFixed(0).padStart(3)}%  "${s}"`);
  }
  console.log('');
}
main().then(() => process.exit(0));
