import { buildStudentText } from '../src/domain/studentText';
import { SEMANTIC_PINGS } from '../src/infra/compliance/studentClient';
import type { ScreeningInput } from '../src/domain/compliance';

// **핑 재선정 측정** (32차 II-3 판정 — 미달 핑 자격 박탈 → r5·P1-A 교집합 ≥0.85 재선정).
// 현행 8문항 + 신규 후보를 r5(8765)·후보(8766) 양쪽에 돌려, 위반 핑은 min(r5, 후보) 최대
// 문장을 고를 근거를 만든다. 선정선: 위반 두 모델 모두 0.85 이상 / 정상 전 라벨 0.30 이하.
//   npx tsx scripts/selectPings.ts

const CANDIDATES: { label: string; texts: string[] }[] = [
  {
    label: 'PROFIT_GUARANTEE',
    texts: [
      '원금 보장 조건으로 진행합니다. 손실이 나도 전액 보전해드립니다.',
      '지금 들어오시면 원금 손실 없이 확정 수익을 약속드립니다.',
      '이 종목은 반드시 오릅니다. 떨어지면 손실액 전부 제가 물어드리겠습니다.',
      '원금은 100% 보장되고 손실이 생기면 제가 보전합니다. 안심하고 매수하세요.',
    ],
  },
  {
    label: 'PRIVATE_INFO',
    texts: [
      '어제 그 회사 재무팀 친구한테 아직 공시 전인 수주 계약 내용을 직접 들었습니다.',
      '내부 관계자에게 받은 미공개 실적 자료인데, 발표 전에 미리 알려드립니다.',
      '임원 지인을 통해 확인한 비공개 인수합병 정보입니다. 공시 뜨기 전에 담으세요.',
      '공시되지 않은 내부 감사 결과를 입수했습니다. 기관보다 먼저 아는 정보입니다.',
    ],
  },
];

function pingInput(content: string): ScreeningInput {
  return { title: '', summary: '', content, assetClass: 'KR_EQUITY', assetName: '', direction: 'UP' } as ScreeningInput;
}

async function score(base: string, input: ScreeningInput): Promise<Record<string, number>> {
  const res = (await (
    await fetch(`${base}/screen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: buildStudentText(input), threshold: 0.01 }),
    })
  ).json()) as { findings: { category: string; score: number }[] };
  const out: Record<string, number> = {};
  for (const f of res.findings) out[f.category] = f.score;
  return out;
}

async function main() {
  const R5 = 'http://127.0.0.1:8765';
  const CAND = 'http://127.0.0.1:8766';
  console.log('── 현행 8문항 (r5 / 후보) ──');
  for (const p of SEMANTIC_PINGS) {
    const [a, b] = await Promise.all([score(R5, p.input), score(CAND, p.input)]);
    if (p.kind === 'violation') {
      const va = a[p.label] ?? 0; const vb = b[p.label] ?? 0;
      const ok = va >= 0.85 && vb >= 0.85;
      console.log(`위반 ${p.label.padEnd(17)} r5 ${va.toFixed(3)} / 후보 ${vb.toFixed(3)} ${ok ? '✓' : '✗ (교집합 미달)'}`);
    } else {
      const ma = Math.max(0, ...Object.values(a)); const mb = Math.max(0, ...Object.values(b));
      const ok = ma <= 0.3 && mb <= 0.3;
      console.log(`정상 ${p.label.padEnd(17)} r5 max ${ma.toFixed(3)} / 후보 max ${mb.toFixed(3)} ${ok ? '✓' : '✗'}`);
    }
  }
  console.log('\n── 신규 후보 (r5 / 후보 / min) ──');
  for (const grp of CANDIDATES) {
    for (const t of grp.texts) {
      const input = pingInput(t);
      const [a, b] = await Promise.all([score(R5, input), score(CAND, input)]);
      const va = a[grp.label] ?? 0; const vb = b[grp.label] ?? 0;
      const mn = Math.min(va, vb);
      console.log(`${grp.label.padEnd(17)} r5 ${va.toFixed(3)} / 후보 ${vb.toFixed(3)} / min ${mn.toFixed(3)} ${mn >= 0.85 ? '✓' : ''}  "${t.slice(0, 34)}…"`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
