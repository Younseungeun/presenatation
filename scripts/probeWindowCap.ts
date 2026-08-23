import { readFileSync } from 'node:fs';
import { createStudentClientFromEnv, splitForWindows } from '../src/infra/compliance/studentClient';
import type { ScreeningInput } from '../src/domain/compliance';

// **창 수 상한 vs 희석 회복 vs 지연** (30차 먼저 재야 할 것 ② · GG-1·GG-3 반증 조건).
// 긴 정상 산문(≈1,500 / 3,000 토큰) 끝에 위반 한 문장. 창 상한 40 / 80 / 200 에서
// ① 꼬리 위반을 잡는가 ② 문서당 지연(ms) ③ 창 수. 상한이 문서를 다 못 덮으면 꼬리는
// 통짜 추론에만 걸리는데 거기서는 희석으로 침묵한다 — "빠른 응답"이 성능을 제물로 한 것인지 본다.
//   STUDENT_SIDECAR_URL=... npx tsx scripts/probeWindowCap.ts

const TAILS: { label: string; text: string }[] = [
  { label: 'PRIVATE_INFO', text: '기관 매수 주문 내역을 비공개 경로로 입수했습니다. 내일 대량 매수 들어옵니다.' },
  { label: 'RUMOR', text: '증권가 찌라시에 따르면 이 회사가 곧 유상증자를 철회한다고 합니다. 소문이 사실이면 급등입니다.' },
  { label: 'SOLICIT_CONTACT', text: '카카오톡 오픈채팅으로 연락 주시면 종목 비밀 정보를 일대일로 알려드립니다.' },
  { label: 'PROFIT_GUARANTEE', text: '이 자리는 무조건 오르는 자리라 손실이 나면 제가 전액 물어드리겠습니다.' },
];

function input(content: string): ScreeningInput {
  return { title: '', summary: '', content, assetClass: 'KR_EQUITY', assetName: '', direction: 'UP' } as ScreeningInput;
}

async function main() {
  const dart = readFileSync('training/holdout/control-dart-clean.jsonl', 'utf-8')
    .split('\n').filter(Boolean)
    .map((l) => (JSON.parse(l) as { text: string }).text)
    .filter((t) => t.length > 120);
  // 토큰 ≈ 글자/2 (한국어 KoELECTRA 실측 근사). 문장 수가 창 수를 정하므로 문장 수도 찍는다
  const prefixes: { name: string; text: string }[] = [];
  for (const targetChars of [3000, 6000]) {
    let p = '';
    for (const s of dart) { if (p.length >= targetChars) break; p += s + ' '; }
    prefixes.push({ name: `≈${targetChars / 2}tk`, text: p });
  }
  for (const cap of [40, 80, 200]) {
    process.env.STUDENT_MAX_WINDOWS = String(cap);
    const client = createStudentClientFromEnv({
      STUDENT_SIDECAR_URL: process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765',
      STUDENT_THRESHOLD: '0.7', STUDENT_MODEL_TAG: `cap${cap}`,
    } as unknown as NodeJS.ProcessEnv)!;
    console.log(`\n── 창 상한 ${cap} ──`);
    for (const pre of prefixes) {
      let caught = 0; let ms = 0;
      const n = splitForWindows(input(pre.text + TAILS[0]!.text)).length;
      for (const t of TAILS) {
        const t0 = Date.now();
        const f = await client.screen(input(pre.text + t.text));
        ms += Date.now() - t0;
        if (f?.findings.some((x) => x.category === t.label)) caught += 1;
      }
      console.log(`  ${pre.name.padEnd(9)} 문장 ${String(n).padStart(3)} · 창 ${Math.min(cap, n - 1).toString().padStart(3)} · 꼬리 위반 회복 ${caught}/${TAILS.length} · 문서당 ${Math.round(ms / TAILS.length)}ms`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
