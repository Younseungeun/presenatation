import AdmZip from 'adm-zip';

// 국내 종목 마스터 꼬리 구간에 무엇이 들어 있는지 **직접 열어 확인한다**.
//   ① ETF·ETN·리츠를 가려낼 증권그룹구분코드의 위치·값
//   ② 거래정지·관리종목 같은 상태 플래그의 위치 (규격을 외워 넣지 않고 분포로 찾는다)
// 코스피와 코스닥은 꼬리 길이가 다르므로 파일마다 자동으로 맞춘다.

const BASE = 'https://new.real.download.dws.co.kr/common/master';

/** 알려진 그룹코드 — 이 값이 tail[1:3]에 오도록 꼬리 길이를 맞춘다 */
const GROUP_CODES = new Set(['ST', 'EF', 'EN', 'RT', 'IF', 'MF', 'DR', 'FS', 'SC', 'BC', 'FE']);

async function load(file: string): Promise<string[]> {
  const res = await fetch(`${BASE}/${file}`);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  return new TextDecoder('euc-kr')
    .decode(zip.getEntries()[0].getData())
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
}

/** 꼬리 길이를 자동 탐지 — 그룹코드가 tail[1:3]에 오는 길이를 찾는다 */
function detectTailLen(lines: string[]): number {
  const codes = lines.filter((l) => /^\d{6}/.test(l.slice(0, 9).trim())).slice(0, 400);
  let best = { len: 0, hits: 0 };
  for (let len = 200; len <= 260; len++) {
    let hits = 0;
    for (const l of codes) {
      if (l.length <= len) continue;
      if (GROUP_CODES.has(l.slice(l.length - len).slice(1, 3))) hits++;
    }
    if (hits > best.hits) best = { len, hits };
  }
  return best.len;
}

async function main() {
  for (const file of ['kospi_code.mst.zip', 'kosdaq_code.mst.zip']) {
    const lines = await load(file);
    const TAIL = detectTailLen(lines);
    const rows = lines
      .filter((l) => /^\d{6}$/.test(l.slice(0, 9).trim()))
      .map((l) => ({
        ticker: l.slice(0, 9).trim(),
        name: l.slice(21, l.length - TAIL).trim(),
        tail: l.slice(l.length - TAIL),
      }));

    console.log(`\n=== ${file} — ${lines.length}줄 / 6자리 ${rows.length}건 / 꼬리 ${TAIL} ===`);

    const groups = new Map<string, { n: number; ex: string[] }>();
    for (const r of rows) {
      const g = r.tail.slice(1, 3);
      const e = groups.get(g) ?? { n: 0, ex: [] };
      e.n++;
      if (e.ex.length < 2) e.ex.push(`${r.ticker} ${r.name.slice(0, 16)}`);
      groups.set(g, e);
    }
    console.log('증권그룹구분코드 tail[1:3]:');
    for (const [g, e] of [...groups.entries()].sort((a, b) => b[1].n - a[1].n)) {
      console.log(`  "${g}" ${String(e.n).padStart(5)}건  ${e.ex.join(' / ')}`);
    }

    // 상태 플래그 후보 — 값이 Y/N뿐이면서 Y가 드문 자리 (거래정지·관리종목·정리매매 등)
    console.log('희소 Y 플래그 후보 (Y가 0.01~8%):');
    for (let i = 0; i < TAIL; i++) {
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.tail[i], (counts.get(r.tail[i]) ?? 0) + 1);
      const keys = [...counts.keys()].sort();
      if (keys.length !== 2 || !keys.includes('Y') || !keys.includes('N')) continue;
      const y = counts.get('Y') ?? 0;
      const ratio = y / rows.length;
      if (ratio > 0.0001 && ratio < 0.08) {
        const ex = rows.filter((r) => r.tail[i] === 'Y').slice(0, 4);
        console.log(
          `  idx ${String(i).padStart(3)}: Y ${String(y).padStart(4)}건 (${(ratio * 100).toFixed(2)}%) — ${ex
            .map((r) => `${r.ticker} ${r.name.slice(0, 12)}`)
            .join(' / ')}`,
        );
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
