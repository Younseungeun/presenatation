import { readFileSync } from 'node:fs';
import { buildStudentText } from '../src/domain/studentText';

// **토큰 희석(어텐션 소모) 저항력 실측** (27차 DD-1 첫째 위협 — 먼저 재야 할 것).
//
// 공격 형태: 앞 400토큰을 흠잡을 데 없는 공시 산문으로 채우고 끝에 위반을 숨긴다.
// 짧을 때 0.8이던 문장이 긴 정상 문맥 뒤에서 0.3으로 곤두박질치면, 실전 리포트
// (긴 글)에서 위반을 놓친다 — 오픈 전에 반드시 알아야 하는 성질.
//
//   STUDENT_SIDECAR_URL=... npx tsx scripts/probeDilution.ts

const BASE = process.env.STUDENT_SIDECAR_URL ?? 'http://127.0.0.1:8765';

const SHORTS: { label: string; text: string }[] = [
  { label: 'PRIVATE_INFO', text: '기관 매수 주문 내역을 비공개 경로로 입수했습니다. 내일 대량 매수 들어옵니다.' },
  { label: 'RUMOR', text: '증권가 찌라시에 따르면 이 회사가 곧 유상증자를 철회한다고 합니다. 소문이 사실이면 급등입니다.' },
  { label: 'SOLICIT_CONTACT', text: '카카오톡 오픈채팅으로 연락 주시면 종목 비밀 정보를 일대일로 알려드립니다.' },
  { label: 'SOLICIT_CONTACT', text: '리딩방에 들어오시면 매수 타이밍을 실시간으로 찍어드립니다. 프로필 링크로 연락 주세요.' },
  { label: 'PROFIT_GUARANTEE', text: '이 자리는 무조건 오르는 자리라 손실이 나면 제가 전액 물어드리겠습니다.' },
];

async function screen(content: string): Promise<{ byLabel: Map<string, number>; tokens: number }> {
  const text = buildStudentText({
    title: '', summary: '', content,
    assetClass: 'KR_EQUITY', assetName: '', direction: 'UP',
  } as never);
  const r = await fetch(`${BASE}/screen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, threshold: 0.01 }),
  });
  const j = (await r.json()) as { findings: { category: string; score: number }[]; token_count: number };
  return { byLabel: new Map(j.findings.map((f) => [f.category, f.score])), tokens: j.token_count };
}

async function main() {
  // 접두 산문: DART 정제판에서 긴 문장을 이어붙여 ~400토큰을 만든다 (정상·방향 주장 없음)
  const dart = readFileSync('training/holdout/control-dart-clean.jsonl', 'utf-8')
    .split('\n').filter(Boolean)
    .map((l) => (JSON.parse(l) as { text: string }).text)
    .filter((t) => t.length > 120)
    .slice(0, 24);

  // 토큰 수를 실측으로 맞춘다 — 문장을 하나씩 붙여 가며 400토큰 근처에서 멈춘다
  let prefix = '';
  for (const s of dart) {
    const probe = await screen(prefix + s + ' ');
    if (probe.tokens > 400) break;
    prefix = prefix + s + ' ';
  }

  console.log(`접두 산문 확보 (약 400토큰 목표)\n`);
  let worst = 1;
  for (const s of SHORTS) {
    const short = await screen(s.text);
    const long = await screen(prefix + s.text);
    const a = short.byLabel.get(s.label) ?? 0;
    const b = long.byLabel.get(s.label) ?? 0;
    worst = Math.min(worst, a > 0 ? b / a : 1);
    console.log(
      `${s.label.padEnd(17)} 단독 ${a.toFixed(3)} (${short.tokens}tk) → 접두 후 ${b.toFixed(3)} (${long.tokens}tk)  ${b >= 0.7 ? '유지' : b >= 0.4 ? '약화' : '**소실**'}`,
    );
  }
  console.log(`\n최악 잔존율 ${(worst * 100).toFixed(0)}%`);
  process.exit(0);
}
main();
